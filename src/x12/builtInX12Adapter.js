/**
 * Built-In X12 Adapter
 *
 * Concrete implementation of X12TranslationAdapter providing standard
 * FHIR <-> X12 278/275 translation for the prior authorization platform.
 *
 * Implements basic segment mapping between FHIR PAS Bundle resources and
 * X12 278 (Health Care Services Review) transaction segments:
 *
 *   FHIR -> X12 278 Mapping:
 *     - Bundle metadata         -> ISA, GS, ST envelope segments
 *     - Claim                   -> BHT (Beginning of Hierarchical Transaction)
 *     - Organization (payer)    -> HL (Hierarchical Level - Information Source), NM1
 *     - Practitioner (provider) -> HL (Hierarchical Level - Provider), NM1
 *     - Patient (subscriber)    -> HL (Hierarchical Level - Subscriber), NM1
 *     - Claim.id                -> TRN (Trace Number)
 *     - Claim.item              -> UM (Health Care Services Review), SV1/SV2
 *     - Claim.diagnosis         -> HI (Diagnosis Codes)
 *     - Claim.supportingInfo    -> PWK (Paperwork), MSG
 *
 *   X12 278 Response -> FHIR Mapping:
 *     - HCR (Health Care Services Review)     -> ClaimResponse.outcome
 *     - AAA (Request Validation)              -> OperationOutcome.issue
 *     - TRN (Trace Number)                    -> ClaimResponse.preAuthRef
 *     - UM (Health Care Services Review Info)  -> ClaimResponse.item
 *
 * Also creates Provenance resources documenting each translation per PAS IG.
 *
 * @see https://www.x12.org/x12-standard/005010X217
 * @see https://hl7.org/fhir/us/davinci-pas/STU2.1/specification.html
 */

const { X12TranslationAdapter, X12_DELIMITERS, X12_TRANSACTION_SETS } = require('./x12TranslationAdapter');
const { generateUUID } = require('../utils/uid.util');
const { logInfo, logError } = require('../operations/common/logging');

/**
 * X12 278 HCR (Health Care Services Review) action code mappings
 * @readonly
 * @enum {Object}
 */
const HCR_ACTION_CODE_MAP = Object.freeze({
    A1: { outcome: 'complete', disposition: 'Certified in total' },
    A2: { outcome: 'complete', disposition: 'Certified - modified' },
    A3: { outcome: 'error', disposition: 'Not certified' },
    A4: { outcome: 'queued', disposition: 'Pended' },
    A5: { outcome: 'queued', disposition: 'Modified' },
    A6: { outcome: 'complete', disposition: 'Cancelled' },
    CT: { outcome: 'complete', disposition: 'Contact payer' },
    NA: { outcome: 'queued', disposition: 'No action required' }
});

/**
 * X12 278 certification type codes
 * @readonly
 * @enum {string}
 */
const CERTIFICATION_TYPE = Object.freeze({
    INITIAL: 'I',
    RENEWAL: 'R',
    REVISION: 'S',
    CANCEL: '3'
});

class BuiltInX12Adapter extends X12TranslationAdapter {
    /**
     * @param {Object} [options]
     * @param {string} [options.senderQualifier] - ISA sender ID qualifier (default: 'ZZ')
     * @param {string} [options.senderId] - ISA sender ID
     * @param {string} [options.receiverQualifier] - ISA receiver ID qualifier (default: 'ZZ')
     * @param {string} [options.receiverId] - ISA receiver ID
     * @param {string} [options.implementationVersion] - X12 implementation version (default: '005010X217')
     */
    constructor (options = {}) {
        super({
            adapterId: options.adapterId || 'built-in-x12',
            adapterVersion: options.adapterVersion || '1.0.0'
        });

        /** @type {string} */
        this.senderQualifier = options.senderQualifier || 'ZZ';

        /** @type {string} */
        this.senderId = options.senderId || 'SENDER';

        /** @type {string} */
        this.receiverQualifier = options.receiverQualifier || 'ZZ';

        /** @type {string} */
        this.receiverId = options.receiverId || 'RECEIVER';

        /** @type {string} */
        this.implementationVersion = options.implementationVersion || '005010X217';

        /**
         * Translation counter for diagnostics
         * @type {number}
         */
        this.translationCount = 0;
    }

    /**
     * Translates a FHIR PAS Request Bundle to X12 278 segments
     *
     * @param {Object} fhirBundle - The PAS Request Bundle
     * @param {import('./x12TranslationAdapter').TranslationContext} [context] - Translation context
     * @returns {Promise<import('./x12TranslationAdapter').TranslationResult>}
     */
    async fhirToX12_278 (fhirBundle, context = {}) {
        this.translationCount++;

        /** @type {string[]} */
        const warnings = [];

        try {
            const entries = fhirBundle.entry || [];

            // Extract resources from the bundle
            const claim = this._findResource(entries, 'Claim');
            const patient = this._findResource(entries, 'Patient');
            const coverage = this._findResource(entries, 'Coverage');
            const practitioner = this._findResource(entries, 'Practitioner') ||
                this._findResource(entries, 'PractitionerRole');
            const organization = this._findResource(entries, 'Organization');

            if (!claim) {
                throw new Error('PAS Request Bundle must contain a Claim resource for X12 278 translation');
            }

            const controlNumber = this._generateControlNumber();
            const segments = [];

            // === Envelope segments ===

            // ISA - Interchange Control Header
            segments.push(this._buildISA(controlNumber, context));

            // GS - Functional Group Header
            segments.push(this._buildGS(controlNumber, context));

            // ST - Transaction Set Header (278)
            segments.push(this._buildST(controlNumber));

            // BHT - Beginning of Hierarchical Transaction
            segments.push(this._buildBHT(claim, controlNumber));

            // === HL Loop 1: Information Source (Payer) ===
            let hlCounter = 1;

            segments.push(
                `HL${X12_DELIMITERS.ELEMENT}${hlCounter}${X12_DELIMITERS.ELEMENT}` +
                `${X12_DELIMITERS.ELEMENT}20${X12_DELIMITERS.ELEMENT}1`
            );

            // NM1 - Payer (Information Source)
            if (coverage && coverage.payor && Array.isArray(coverage.payor) && coverage.payor.length > 0) {
                segments.push(this._buildPayerNM1(coverage, organization));
            } else if (claim.insurer) {
                segments.push(this._buildInsurerNM1(claim, entries));
            } else {
                warnings.push('No payer information found in Coverage.payor or Claim.insurer');
                segments.push(
                    `NM1${X12_DELIMITERS.ELEMENT}PR${X12_DELIMITERS.ELEMENT}2` +
                    `${X12_DELIMITERS.ELEMENT}UNKNOWN PAYER`
                );
            }

            // === HL Loop 2: Information Receiver (Provider) ===
            hlCounter++;
            segments.push(
                `HL${X12_DELIMITERS.ELEMENT}${hlCounter}${X12_DELIMITERS.ELEMENT}1` +
                `${X12_DELIMITERS.ELEMENT}21${X12_DELIMITERS.ELEMENT}1`
            );

            // NM1 - Provider (Information Receiver / Requester)
            if (practitioner) {
                segments.push(this._buildProviderNM1(practitioner));
            } else if (claim.provider) {
                const providerResource = this._resolveReference(entries, claim.provider.reference);
                if (providerResource) {
                    segments.push(this._buildProviderNM1(providerResource));
                } else {
                    warnings.push('Could not resolve Claim.provider reference to a Practitioner');
                }
            }

            // REF - Provider secondary identification
            if (practitioner) {
                const taxId = this._findIdentifier(practitioner, 'http://hl7.org/fhir/sid/us-ein');
                if (taxId) {
                    segments.push(
                        `REF${X12_DELIMITERS.ELEMENT}EI${X12_DELIMITERS.ELEMENT}${taxId}`
                    );
                }
            }

            // === HL Loop 3: Subscriber ===
            hlCounter++;
            segments.push(
                `HL${X12_DELIMITERS.ELEMENT}${hlCounter}${X12_DELIMITERS.ELEMENT}2` +
                `${X12_DELIMITERS.ELEMENT}22${X12_DELIMITERS.ELEMENT}1`
            );

            // TRN - Subscriber Trace Number
            segments.push(
                `TRN${X12_DELIMITERS.ELEMENT}1${X12_DELIMITERS.ELEMENT}` +
                `${context.platformTrackingId || claim.id || controlNumber}` +
                `${X12_DELIMITERS.ELEMENT}${controlNumber}`
            );

            // NM1 - Subscriber (Patient / Beneficiary)
            if (patient) {
                segments.push(this._buildPatientNM1(patient));
            }

            // DMG - Subscriber Demographics
            if (patient && patient.birthDate) {
                const gender = this._mapFhirGenderToX12(patient.gender);
                segments.push(
                    `DMG${X12_DELIMITERS.ELEMENT}D8${X12_DELIMITERS.ELEMENT}` +
                    `${patient.birthDate.replace(/-/g, '')}${X12_DELIMITERS.ELEMENT}${gender}`
                );
            }

            // === HL Loop 4: Patient Event (Service Level) ===
            hlCounter++;
            segments.push(
                `HL${X12_DELIMITERS.ELEMENT}${hlCounter}${X12_DELIMITERS.ELEMENT}3` +
                `${X12_DELIMITERS.ELEMENT}EV${X12_DELIMITERS.ELEMENT}1`
            );

            // TRN - Patient Event Trace Number
            segments.push(
                `TRN${X12_DELIMITERS.ELEMENT}2${X12_DELIMITERS.ELEMENT}` +
                `${claim.id || controlNumber}${X12_DELIMITERS.ELEMENT}${controlNumber}`
            );

            // UM - Health Care Services Review Information
            segments.push(this._buildUM(claim));

            // HSD - Health Care Services Delivery (quantity/frequency)
            if (claim.item && claim.item.length > 0) {
                const firstItem = claim.item[0];
                if (firstItem.quantity) {
                    segments.push(
                        `HSD${X12_DELIMITERS.ELEMENT}VS${X12_DELIMITERS.ELEMENT}` +
                        `${firstItem.quantity.value || ''}`
                    );
                }
            }

            // HI - Diagnosis Code segments
            const hiSegments = this._buildHI(claim);
            segments.push(...hiSegments);

            // === Service Line Level ===
            if (claim.item && Array.isArray(claim.item)) {
                for (let i = 0; i < claim.item.length; i++) {
                    const item = claim.item[i];

                    // SV1 - Professional Service
                    if (item.productOrService) {
                        segments.push(this._buildSV1(item, i));
                    }

                    // DTP - Service Date
                    if (item.servicedDate || item.servicedPeriod) {
                        segments.push(this._buildServiceDateDTP(item));
                    }
                }
            }

            // PWK - Paperwork (for attached documents referenced in supportingInfo)
            if (claim.supportingInfo && Array.isArray(claim.supportingInfo)) {
                for (const info of claim.supportingInfo) {
                    if (info.valueAttachment || info.valueReference) {
                        segments.push(this._buildPWK(info));
                    }
                }
            }

            // === Trailer segments ===

            // SE - Transaction Set Trailer
            const transactionSegmentCount = segments.length - 2 + 1; // exclude ISA, GS; include SE
            segments.push(
                `SE${X12_DELIMITERS.ELEMENT}${transactionSegmentCount}${X12_DELIMITERS.ELEMENT}${controlNumber}`
            );

            // GE - Functional Group Trailer
            segments.push(`GE${X12_DELIMITERS.ELEMENT}1${X12_DELIMITERS.ELEMENT}${controlNumber}`);

            // IEA - Interchange Control Trailer
            segments.push(
                `IEA${X12_DELIMITERS.ELEMENT}1${X12_DELIMITERS.ELEMENT}${controlNumber.padStart(9, '0')}`
            );

            const x12Data = segments.join(X12_DELIMITERS.SEGMENT) + X12_DELIMITERS.SEGMENT;

            logInfo('FHIR to X12 278 translation completed', {
                claimId: claim.id,
                segmentCount: segments.length,
                warningCount: warnings.length,
                translationNumber: this.translationCount
            });

            return {
                x12Data,
                segments,
                metadata: {
                    segmentCount: segments.length,
                    transactionSet: X12_TRANSACTION_SETS.TS_278_REQUEST,
                    controlNumber,
                    warnings
                }
            };
        } catch (error) {
            logError('FHIR to X12 278 translation failed', {
                error: error.message,
                stack: error.stack,
                translationNumber: this.translationCount
            });
            throw error;
        }
    }

    /**
     * Translates an X12 278 response back to a FHIR PAS Response Bundle
     *
     * @param {string} x12Data - Raw X12 278 response string
     * @param {import('./x12TranslationAdapter').TranslationContext} [context] - Translation context
     * @returns {Promise<import('./x12TranslationAdapter').ReverseTranslationResult>}
     */
    async x12_278ToFhir (x12Data, context = {}) {
        this.translationCount++;

        /** @type {string[]} */
        const warnings = [];
        /** @type {string[]} */
        const unmappedSegments = [];

        try {
            // Parse X12 segments
            const rawSegments = x12Data.split(X12_DELIMITERS.SEGMENT).filter(s => s.trim());
            const parsedSegments = rawSegments.map(seg => {
                const elements = seg.split(X12_DELIMITERS.ELEMENT);
                return { id: elements[0], elements, raw: seg };
            });

            // Extract key segments
            const bhtSegment = parsedSegments.find(s => s.id === 'BHT');
            const trnSegments = parsedSegments.filter(s => s.id === 'TRN');
            const hcrSegment = parsedSegments.find(s => s.id === 'HCR');
            const aaaSegments = parsedSegments.filter(s => s.id === 'AAA');
            const umSegment = parsedSegments.find(s => s.id === 'UM');
            const nm1Segments = parsedSegments.filter(s => s.id === 'NM1');
            const hiSegments = parsedSegments.filter(s => s.id === 'HI');

            // Determine outcome from HCR segment
            let outcome = 'queued';
            let disposition = 'Pending Review';

            if (hcrSegment) {
                const actionCode = hcrSegment.elements[1];
                const mapped = HCR_ACTION_CODE_MAP[actionCode];
                if (mapped) {
                    outcome = mapped.outcome;
                    disposition = mapped.disposition;
                } else {
                    warnings.push(`Unknown HCR action code: ${actionCode}`);
                }
            }

            // Extract trace/preauth reference number from TRN
            let preAuthRef = null;
            if (trnSegments.length > 0) {
                preAuthRef = trnSegments[0].elements[2] || null;
            }

            // Build ClaimResponse
            const claimResponseId = generateUUID();
            const claimResponse = {
                resourceType: 'ClaimResponse',
                id: claimResponseId,
                status: 'active',
                type: {
                    coding: [{
                        system: 'http://terminology.hl7.org/CodeSystem/claim-type',
                        code: 'professional'
                    }]
                },
                use: 'preauthorization',
                outcome,
                disposition,
                preAuthRef,
                created: new Date().toISOString(),
                meta: {
                    profile: [
                        'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-claimresponse'
                    ]
                }
            };

            // Map AAA (error/rejection) segments to OperationOutcome issues
            if (aaaSegments.length > 0) {
                claimResponse.error = aaaSegments.map(aaa => {
                    const rejectReasonCode = aaa.elements[3] || '';
                    const followUpActionCode = aaa.elements[4] || '';
                    return {
                        code: {
                            coding: [{
                                system: 'http://terminology.hl7.org/CodeSystem/adjudication-error',
                                code: rejectReasonCode,
                                display: `X12 AAA reject reason: ${rejectReasonCode}, follow-up: ${followUpActionCode}`
                            }]
                        }
                    };
                });
            }

            // Map UM segment to item-level review details
            if (umSegment) {
                const serviceTypeCode = umSegment.elements[3] || '';
                const certificationTypeCode = umSegment.elements[2] || '';
                claimResponse.extension = claimResponse.extension || [];
                claimResponse.extension.push({
                    url: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/extension-reviewAction',
                    extension: [
                        {
                            url: 'number',
                            valueString: preAuthRef || ''
                        },
                        {
                            url: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/extension-reviewActionCode',
                            valueCodeableConcept: {
                                coding: [{
                                    system: 'https://codesystem.x12.org/005010/306',
                                    code: hcrSegment ? hcrSegment.elements[1] : '',
                                    display: disposition
                                }]
                            }
                        }
                    ]
                });
            }

            // Track unmapped segments
            const mappedSegmentIds = new Set(['ISA', 'GS', 'ST', 'BHT', 'HL', 'TRN', 'NM1', 'HCR', 'AAA', 'UM', 'HI', 'DMG', 'DTP', 'SE', 'GE', 'IEA', 'REF', 'SV1', 'SV2', 'HSD', 'PWK', 'MSG']);
            for (const seg of parsedSegments) {
                if (!mappedSegmentIds.has(seg.id)) {
                    unmappedSegments.push(seg.raw);
                }
            }

            // Build the Response Bundle
            const responseBundle = {
                resourceType: 'Bundle',
                id: generateUUID(),
                type: 'collection',
                timestamp: new Date().toISOString(),
                entry: [
                    {
                        fullUrl: `urn:uuid:${claimResponseId}`,
                        resource: claimResponse
                    }
                ],
                meta: {
                    profile: [
                        'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-pas-response-bundle'
                    ]
                }
            };

            // Create Provenance for this translation
            const provenance = this.createProvenance(
                { resourceType: 'Binary', id: 'x12-278-response' },
                responseBundle,
                {
                    translationDirection: 'x12-to-fhir',
                    transactionSet: '278',
                    platformTrackingId: context.platformTrackingId,
                    warnings
                }
            );

            logInfo('X12 278 to FHIR translation completed', {
                outcome,
                claimResponseId,
                preAuthRef,
                segmentCount: parsedSegments.length,
                unmappedCount: unmappedSegments.length,
                translationNumber: this.translationCount
            });

            return {
                bundle: responseBundle,
                provenance,
                metadata: {
                    warnings,
                    unmappedSegments
                }
            };
        } catch (error) {
            logError('X12 278 to FHIR translation failed', {
                error: error.message,
                stack: error.stack,
                translationNumber: this.translationCount
            });
            throw error;
        }
    }

    /**
     * Translates FHIR attachment data to X12 275 (Additional Information)
     *
     * @param {Object} fhirResources
     * @param {import('./x12TranslationAdapter').TranslationContext} [context]
     * @returns {Promise<import('./x12TranslationAdapter').TranslationResult>}
     */
    async fhirToX12_275 (fhirResources, context = {}) {
        this.translationCount++;
        const warnings = [];

        try {
            const controlNumber = this._generateControlNumber();
            const segments = [];

            // Envelope
            segments.push(this._buildISA(controlNumber, context));
            segments.push(this._buildGS(controlNumber, context));
            segments.push(`ST${X12_DELIMITERS.ELEMENT}275${X12_DELIMITERS.ELEMENT}${controlNumber}`);

            // BGN - Beginning Segment
            const now = new Date();
            segments.push(
                `BGN${X12_DELIMITERS.ELEMENT}02${X12_DELIMITERS.ELEMENT}` +
                `${controlNumber}${X12_DELIMITERS.ELEMENT}${this._formatDateFull(now)}`
            );

            // NM1 - Payer
            segments.push(`NM1${X12_DELIMITERS.ELEMENT}PR${X12_DELIMITERS.ELEMENT}2`);

            // NM1 - Provider
            segments.push(`NM1${X12_DELIMITERS.ELEMENT}1P${X12_DELIMITERS.ELEMENT}2`);

            // TRN - Tracking Number (linked to the PA request)
            const trackingId = context.platformTrackingId || controlNumber;
            segments.push(
                `TRN${X12_DELIMITERS.ELEMENT}2${X12_DELIMITERS.ELEMENT}${trackingId}`
            );

            // CAT - Category of Patient Information Service
            segments.push(
                `CAT${X12_DELIMITERS.ELEMENT}AE${X12_DELIMITERS.ELEMENT}TX`
            );

            // EFI - Electronic Format Identification
            const documentReference = fhirResources.documentReference;
            if (documentReference && documentReference.content && documentReference.content.length > 0) {
                const contentType = documentReference.content[0].attachment &&
                    documentReference.content[0].attachment.contentType
                    ? documentReference.content[0].attachment.contentType
                    : 'application/pdf';
                segments.push(
                    `EFI${X12_DELIMITERS.ELEMENT}05${X12_DELIMITERS.ELEMENT}${contentType}`
                );
            }

            // BIN - Binary Data Segment
            const binary = fhirResources.binary;
            if (binary && binary.data) {
                segments.push(
                    `BIN${X12_DELIMITERS.ELEMENT}${binary.data.length}${X12_DELIMITERS.ELEMENT}${binary.data}`
                );
            } else if (documentReference && documentReference.content &&
                       documentReference.content[0] && documentReference.content[0].attachment &&
                       documentReference.content[0].attachment.data) {
                const data = documentReference.content[0].attachment.data;
                segments.push(
                    `BIN${X12_DELIMITERS.ELEMENT}${data.length}${X12_DELIMITERS.ELEMENT}${data}`
                );
            } else {
                warnings.push('No binary data found in DocumentReference or Binary resource');
            }

            // Trailer segments
            const transactionSegmentCount = segments.length - 2 + 1;
            segments.push(
                `SE${X12_DELIMITERS.ELEMENT}${transactionSegmentCount}${X12_DELIMITERS.ELEMENT}${controlNumber}`
            );
            segments.push(`GE${X12_DELIMITERS.ELEMENT}1${X12_DELIMITERS.ELEMENT}${controlNumber}`);
            segments.push(
                `IEA${X12_DELIMITERS.ELEMENT}1${X12_DELIMITERS.ELEMENT}${controlNumber.padStart(9, '0')}`
            );

            const x12Data = segments.join(X12_DELIMITERS.SEGMENT) + X12_DELIMITERS.SEGMENT;

            logInfo('FHIR to X12 275 translation completed', {
                segmentCount: segments.length,
                translationNumber: this.translationCount
            });

            return {
                x12Data,
                segments,
                metadata: {
                    segmentCount: segments.length,
                    transactionSet: X12_TRANSACTION_SETS.TS_275,
                    controlNumber,
                    warnings
                }
            };
        } catch (error) {
            logError('FHIR to X12 275 translation failed', {
                error: error.message,
                translationNumber: this.translationCount
            });
            throw error;
        }
    }

    /**
     * Creates a FHIR Provenance resource documenting the X12 translation
     *
     * @param {Object} sourceResource
     * @param {Object} targetResource
     * @param {Object} [options]
     * @returns {Object} FHIR Provenance resource
     */
    createProvenance (sourceResource, targetResource, options = {}) {
        const now = new Date().toISOString();
        const provenanceId = generateUUID();

        const direction = options.translationDirection || 'fhir-to-x12';
        const transactionSet = options.transactionSet || '278';

        const sourceDisplay = direction === 'fhir-to-x12'
            ? `FHIR PAS Bundle (${sourceResource.resourceType || 'Bundle'})`
            : `X12 ${transactionSet} Transaction`;

        const targetDisplay = direction === 'fhir-to-x12'
            ? `X12 ${transactionSet} Transaction`
            : `FHIR PAS Bundle (${targetResource.resourceType || 'Bundle'})`;

        const provenance = {
            resourceType: 'Provenance',
            id: provenanceId,
            meta: {
                profile: [
                    'http://hl7.org/fhir/us/core/StructureDefinition/us-core-provenance'
                ]
            },
            target: [{
                reference: targetResource.resourceType && targetResource.id
                    ? `${targetResource.resourceType}/${targetResource.id}`
                    : 'Binary/x12-translation'
            }],
            occurred: {
                dateTime: now
            },
            recorded: now,
            activity: {
                coding: [{
                    system: 'http://terminology.hl7.org/CodeSystem/v3-DataOperation',
                    code: 'TRANS',
                    display: 'Transform/Translate'
                }]
            },
            agent: [
                {
                    type: {
                        coding: [{
                            system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type',
                            code: 'assembler',
                            display: 'Assembler'
                        }]
                    },
                    who: {
                        display: `FHIR Prior Authorization Platform - X12 Translation Engine (${this.adapterId} v${this.adapterVersion})`
                    }
                }
            ],
            entity: [
                {
                    role: 'source',
                    what: {
                        display: sourceDisplay
                    }
                },
                {
                    role: 'derivation',
                    what: {
                        display: targetDisplay
                    }
                }
            ]
        };

        // Add platform tracking ID if available
        if (options.platformTrackingId) {
            provenance.extension = [{
                url: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/extension-pas-tracking',
                valueString: options.platformTrackingId
            }];
        }

        // Add translation warnings as Provenance.text if any
        if (options.warnings && options.warnings.length > 0) {
            provenance.text = {
                status: 'generated',
                div: `<div xmlns="http://www.w3.org/1999/xhtml">` +
                     `<p>Translation direction: ${direction}</p>` +
                     `<p>Transaction set: ${transactionSet}</p>` +
                     `<p>Warnings: ${options.warnings.join('; ')}</p>` +
                     `</div>`
            };
        }

        return provenance;
    }

    // =========================================================================
    // Private helper methods for building X12 segments
    // =========================================================================

    /**
     * Generates a 9-character control number for X12 envelope segments
     * @returns {string}
     * @private
     */
    _generateControlNumber () {
        return generateUUID().replace(/-/g, '').substring(0, 9);
    }

    /**
     * Builds the ISA (Interchange Control Header) segment
     * @param {string} controlNumber
     * @param {import('./x12TranslationAdapter').TranslationContext} [context]
     * @returns {string}
     * @private
     */
    _buildISA (controlNumber, context = {}) {
        const sep = X12_DELIMITERS.ELEMENT;
        const date = this._formatDateShort(new Date());
        const time = this._formatTimeShort(new Date());
        const senderQual = context.senderApplicationId ? 'ZZ' : this.senderQualifier;
        const senderId = (context.senderApplicationId || this.senderId).padEnd(15);
        const receiverQual = context.receiverApplicationId ? 'ZZ' : this.receiverQualifier;
        const receiverId = (context.receiverApplicationId || this.receiverId).padEnd(15);

        return `ISA${sep}00${sep}          ${sep}00${sep}          ` +
            `${sep}${senderQual}${sep}${senderId}` +
            `${sep}${receiverQual}${sep}${receiverId}` +
            `${sep}${date}${sep}${time}` +
            `${sep}${X12_DELIMITERS.REPETITION}${sep}00501` +
            `${sep}${controlNumber.padStart(9, '0')}${sep}0${sep}P` +
            `${sep}${X12_DELIMITERS.COMPONENT}`;
    }

    /**
     * Builds the GS (Functional Group Header) segment
     * @param {string} controlNumber
     * @param {import('./x12TranslationAdapter').TranslationContext} [context]
     * @returns {string}
     * @private
     */
    _buildGS (controlNumber, context = {}) {
        const sep = X12_DELIMITERS.ELEMENT;
        const date = this._formatDateFull(new Date());
        const time = this._formatTimeFull(new Date());
        const senderId = context.senderApplicationId || this.senderId;
        const receiverId = context.receiverApplicationId || this.receiverId;

        return `GS${sep}HI${sep}${senderId}${sep}${receiverId}` +
            `${sep}${date}${sep}${time}${sep}${controlNumber}` +
            `${sep}X${sep}${this.implementationVersion}`;
    }

    /**
     * Builds the ST (Transaction Set Header) segment for 278
     * @param {string} controlNumber
     * @returns {string}
     * @private
     */
    _buildST (controlNumber) {
        return `ST${X12_DELIMITERS.ELEMENT}278${X12_DELIMITERS.ELEMENT}${controlNumber}`;
    }

    /**
     * Builds the BHT (Beginning of Hierarchical Transaction) segment
     * @param {Object} claim
     * @param {string} controlNumber
     * @returns {string}
     * @private
     */
    _buildBHT (claim, controlNumber) {
        const sep = X12_DELIMITERS.ELEMENT;
        const date = this._formatDateFull(new Date());
        const time = this._formatTimeFull(new Date());
        // BHT01: 0007 = Information Source, Subscriber, Dependent
        // BHT02: 11 = Request (13 = Inquiry)
        const purposeCode = claim.use === 'preauthorization' ? '11' : '13';
        return `BHT${sep}0007${sep}${purposeCode}${sep}${controlNumber}${sep}${date}${sep}${time}`;
    }

    /**
     * Builds NM1 segment for the payer (Information Source) from Coverage.payor
     * @param {Object} coverage
     * @param {Object} [organization]
     * @returns {string}
     * @private
     */
    _buildPayerNM1 (coverage, organization) {
        const sep = X12_DELIMITERS.ELEMENT;
        const payorRef = coverage.payor[0];
        let payerName = payorRef.display || 'PAYER';
        let payerNpi = '';

        // If we have the Organization resource, use its details
        if (organization) {
            payerName = organization.name || payerName;
            payerNpi = this._findIdentifier(organization, 'http://hl7.org/fhir/sid/us-npi') || '';
        }

        // NM101=PR (Payer), NM102=2 (Non-Person Entity)
        if (payerNpi) {
            return `NM1${sep}PR${sep}2${sep}${payerName}${sep}${sep}${sep}${sep}${sep}PI${sep}${payerNpi}`;
        }
        return `NM1${sep}PR${sep}2${sep}${payerName}`;
    }

    /**
     * Builds NM1 segment for the insurer from Claim.insurer reference
     * @param {Object} claim
     * @param {Object[]} entries
     * @returns {string}
     * @private
     */
    _buildInsurerNM1 (claim, entries) {
        const sep = X12_DELIMITERS.ELEMENT;
        const insurerResource = this._resolveReference(entries, claim.insurer.reference);
        const name = insurerResource ? (insurerResource.name || 'INSURER') : 'INSURER';
        return `NM1${sep}PR${sep}2${sep}${name}`;
    }

    /**
     * Builds NM1 segment for the provider (Practitioner/PractitionerRole)
     * @param {Object} practitioner
     * @returns {string}
     * @private
     */
    _buildProviderNM1 (practitioner) {
        const sep = X12_DELIMITERS.ELEMENT;
        const lastName = (practitioner.name && practitioner.name[0])
            ? practitioner.name[0].family || ''
            : '';
        const firstName = (practitioner.name && practitioner.name[0] && practitioner.name[0].given)
            ? practitioner.name[0].given[0] || ''
            : '';
        const npi = this._findIdentifier(practitioner, 'http://hl7.org/fhir/sid/us-npi') || '';

        // NM101=1P (Provider), NM102=1 (Person)
        return `NM1${sep}1P${sep}1${sep}${lastName}${sep}${firstName}` +
            `${sep}${sep}${sep}${sep}XX${sep}${npi}`;
    }

    /**
     * Builds NM1 segment for the patient/subscriber
     * @param {Object} patient
     * @returns {string}
     * @private
     */
    _buildPatientNM1 (patient) {
        const sep = X12_DELIMITERS.ELEMENT;
        const lastName = (patient.name && patient.name[0])
            ? patient.name[0].family || ''
            : '';
        const firstName = (patient.name && patient.name[0] && patient.name[0].given)
            ? patient.name[0].given[0] || ''
            : '';
        const memberId = (patient.identifier && patient.identifier[0])
            ? patient.identifier[0].value || ''
            : '';

        // NM101=IL (Insured/Subscriber), NM102=1 (Person)
        return `NM1${sep}IL${sep}1${sep}${lastName}${sep}${firstName}` +
            `${sep}${sep}${sep}${sep}MI${sep}${memberId}`;
    }

    /**
     * Builds the UM (Health Care Services Review Information) segment
     * @param {Object} claim
     * @returns {string}
     * @private
     */
    _buildUM (claim) {
        const sep = X12_DELIMITERS.ELEMENT;
        // UM01: HS = Health Services Review
        // UM02: I = Initial, R = Renewal, S = Revision
        const certType = CERTIFICATION_TYPE.INITIAL;
        // UM03: Service Type Code from first item
        const serviceType = (claim.item && claim.item[0] && claim.item[0].productOrService &&
            claim.item[0].productOrService.coding && claim.item[0].productOrService.coding[0])
            ? claim.item[0].productOrService.coding[0].code || ''
            : '';
        // UM04: Level of service (not always used)
        return `UM${sep}HS${sep}${certType}${sep}${serviceType}`;
    }

    /**
     * Builds HI (Health Care Information Codes) segments from Claim.diagnosis
     * @param {Object} claim
     * @returns {string[]}
     * @private
     */
    _buildHI (claim) {
        const segments = [];
        const diagnoses = claim.diagnosis || [];

        for (let i = 0; i < diagnoses.length; i++) {
            const diag = diagnoses[i];
            const codeableConcept = diag.diagnosisCodeableConcept || diag.diagnosisReference || {};
            const coding = (codeableConcept.coding && codeableConcept.coding[0]) || {};
            const code = coding.code || '';

            // HI01 qualifier: ABK = Principal Diagnosis, ABF = Admitting Diagnosis, BF = Diagnosis
            let qualifier;
            if (i === 0) {
                qualifier = 'ABK';
            } else if (diag.type && Array.isArray(diag.type)) {
                const diagType = diag.type[0] && diag.type[0].coding && diag.type[0].coding[0];
                qualifier = diagType && diagType.code === 'admitting' ? 'ABF' : 'BF';
            } else {
                qualifier = 'BF';
            }

            segments.push(
                `HI${X12_DELIMITERS.ELEMENT}${qualifier}${X12_DELIMITERS.COMPONENT}${code}`
            );
        }

        return segments;
    }

    /**
     * Builds SV1 (Professional Service) segment from Claim.item
     * @param {Object} item
     * @param {number} index
     * @returns {string}
     * @private
     */
    _buildSV1 (item, index) {
        const sep = X12_DELIMITERS.ELEMENT;
        const comp = X12_DELIMITERS.COMPONENT;
        const coding = (item.productOrService.coding && item.productOrService.coding[0]) || {};
        const system = coding.system || '';
        const code = coding.code || '';

        // Map FHIR coding system to X12 qualifier
        let qualifier = 'HC'; // HCPCS
        if (system.includes('cpt')) {
            qualifier = 'HC';
        } else if (system.includes('hcpcs')) {
            qualifier = 'HC';
        } else if (system.includes('icd')) {
            qualifier = 'ID';
        }

        const amount = (item.unitPrice && item.unitPrice.value) ? item.unitPrice.value : '';
        const units = (item.quantity && item.quantity.value) ? item.quantity.value : '1';

        return `SV1${sep}${qualifier}${comp}${code}${sep}${amount}${sep}UN${sep}${units}`;
    }

    /**
     * Builds DTP (Date or Time Period) segment for service dates
     * @param {Object} item
     * @returns {string}
     * @private
     */
    _buildServiceDateDTP (item) {
        const sep = X12_DELIMITERS.ELEMENT;

        if (item.servicedPeriod) {
            const start = item.servicedPeriod.start
                ? item.servicedPeriod.start.substring(0, 10).replace(/-/g, '')
                : '';
            const end = item.servicedPeriod.end
                ? item.servicedPeriod.end.substring(0, 10).replace(/-/g, '')
                : start;
            // DTP01: 472 = Service, DTP02: RD8 = Range of Dates
            return `DTP${sep}472${sep}RD8${sep}${start}-${end}`;
        }

        if (item.servicedDate) {
            const date = item.servicedDate.substring(0, 10).replace(/-/g, '');
            // DTP01: 472 = Service, DTP02: D8 = Date
            return `DTP${sep}472${sep}D8${sep}${date}`;
        }

        return `DTP${sep}472${sep}D8${sep}${this._formatDateFull(new Date())}`;
    }

    /**
     * Builds PWK (Paperwork) segment for attachment references
     * @param {Object} supportingInfo - Claim.supportingInfo entry
     * @returns {string}
     * @private
     */
    _buildPWK (supportingInfo) {
        const sep = X12_DELIMITERS.ELEMENT;
        // PWK01: Report Type (OZ = Support Data for Claim)
        // PWK02: Report Transmission (EL = Electronic)
        return `PWK${sep}OZ${sep}EL`;
    }

    // =========================================================================
    // Utility methods
    // =========================================================================

    /**
     * Finds a resource by type in bundle entries
     * @param {Object[]} entries
     * @param {string} resourceType
     * @returns {Object|null}
     * @private
     */
    _findResource (entries, resourceType) {
        const entry = entries.find(e => e.resource && e.resource.resourceType === resourceType);
        return entry ? entry.resource : null;
    }

    /**
     * Resolves a FHIR reference to a resource in bundle entries
     * @param {Object[]} entries
     * @param {string} reference - e.g., "Organization/123"
     * @returns {Object|null}
     * @private
     */
    _resolveReference (entries, reference) {
        if (!reference) {
            return null;
        }

        // Handle urn:uuid references
        for (const entry of entries) {
            if (entry.fullUrl === reference) {
                return entry.resource;
            }
        }

        // Handle relative references
        const parts = reference.split('/');
        if (parts.length >= 2) {
            const refType = parts[parts.length - 2];
            const refId = parts[parts.length - 1];
            const found = entries.find(
                e => e.resource && e.resource.resourceType === refType && e.resource.id === refId
            );
            return found ? found.resource : null;
        }

        return null;
    }

    /**
     * Finds an identifier value by system on a FHIR resource
     * @param {Object} resource
     * @param {string} system
     * @returns {string|null}
     * @private
     */
    _findIdentifier (resource, system) {
        if (!resource || !resource.identifier || !Array.isArray(resource.identifier)) {
            return null;
        }
        const ident = resource.identifier.find(id => id.system === system);
        return ident ? ident.value : null;
    }

    /**
     * Maps FHIR administrative gender to X12 gender code
     * @param {string} fhirGender
     * @returns {string}
     * @private
     */
    _mapFhirGenderToX12 (fhirGender) {
        switch (fhirGender) {
            case 'male': return 'M';
            case 'female': return 'F';
            case 'other': return 'U';
            default: return 'U';
        }
    }

    /**
     * Formats a date as YYMMDD (for ISA segment)
     * @param {Date} date
     * @returns {string}
     * @private
     */
    _formatDateShort (date) {
        return date.toISOString().slice(2, 10).replace(/-/g, '');
    }

    /**
     * Formats a date as CCYYMMDD
     * @param {Date} date
     * @returns {string}
     * @private
     */
    _formatDateFull (date) {
        return date.toISOString().slice(0, 10).replace(/-/g, '');
    }

    /**
     * Formats time as HHMM (for ISA segment)
     * @param {Date} date
     * @returns {string}
     * @private
     */
    _formatTimeShort (date) {
        return date.toISOString().slice(11, 16).replace(/:/g, '');
    }

    /**
     * Formats time as HHMMSS
     * @param {Date} date
     * @returns {string}
     * @private
     */
    _formatTimeFull (date) {
        return date.toISOString().slice(11, 19).replace(/:/g, '');
    }
}

module.exports = {
    BuiltInX12Adapter,
    HCR_ACTION_CODE_MAP,
    CERTIFICATION_TYPE
};
