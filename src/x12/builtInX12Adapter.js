/**
 * BuiltInX12Adapter - Built-in implementation of FHIR <-> X12 278/275 translation
 *
 * Maps FHIR PAS Bundle resources to X12 278 segments and back.
 * Per Da Vinci PAS IG 2.1, the intermediary must be able to convert
 * between FHIR and X12 278 format for HIPAA compliance.
 */
const { X12TranslationAdapter } = require('./x12TranslationAdapter');
const { generateUUID } = require('../utils/uid.util');
const { logInfo, logError } = require('../operations/common/logging');

// X12 278 segment separators
const SEGMENT_TERMINATOR = '~';
const ELEMENT_SEPARATOR = '*';
const SUB_ELEMENT_SEPARATOR = ':';

class BuiltInX12Adapter extends X12TranslationAdapter {
    constructor () {
        super();
    }

    /**
     * Translate a PAS FHIR Request Bundle to X12 278 format
     * @param {Object} pasRequestBundle
     * @returns {Promise<{x12String: string, segments: Object[]}>}
     */
    async fhirToX12_278 (pasRequestBundle) {
        try {
            const entries = pasRequestBundle.entry || [];
            const claim = entries.find(e => e.resource?.resourceType === 'Claim')?.resource;
            const patient = entries.find(e => e.resource?.resourceType === 'Patient')?.resource;
            const coverage = entries.find(e => e.resource?.resourceType === 'Coverage')?.resource;
            const practitioner = entries.find(e =>
                e.resource?.resourceType === 'Practitioner' ||
                e.resource?.resourceType === 'PractitionerRole'
            )?.resource;

            if (!claim) {
                throw new Error('PAS Request Bundle must contain a Claim resource');
            }

            const segments = [];
            const controlNumber = generateUUID().replace(/-/g, '').substring(0, 9);

            // ISA - Interchange Control Header
            segments.push(this.buildISA(controlNumber));

            // GS - Functional Group Header
            segments.push(this.buildGS(controlNumber));

            // ST - Transaction Set Header (278)
            segments.push(`ST${ELEMENT_SEPARATOR}278${ELEMENT_SEPARATOR}${controlNumber}`);

            // BHT - Beginning of Hierarchical Transaction
            segments.push(this.buildBHT(claim, controlNumber));

            // HL - Hierarchical Level (Information Source)
            segments.push(`HL${ELEMENT_SEPARATOR}1${ELEMENT_SEPARATOR}${ELEMENT_SEPARATOR}20${ELEMENT_SEPARATOR}1`);

            // NM1 - Payer Information
            if (coverage?.payor?.[0]) {
                segments.push(this.buildPayerNM1(coverage));
            }

            // HL - Hierarchical Level (Information Receiver / Provider)
            segments.push(`HL${ELEMENT_SEPARATOR}2${ELEMENT_SEPARATOR}1${ELEMENT_SEPARATOR}21${ELEMENT_SEPARATOR}1`);

            // NM1 - Provider/Requester Information
            if (practitioner) {
                segments.push(this.buildProviderNM1(practitioner));
            }

            // HL - Hierarchical Level (Subscriber)
            segments.push(`HL${ELEMENT_SEPARATOR}3${ELEMENT_SEPARATOR}2${ELEMENT_SEPARATOR}22${ELEMENT_SEPARATOR}1`);

            // NM1 - Subscriber Information
            if (patient) {
                segments.push(this.buildPatientNM1(patient));
            }

            // TRN - Trace Number
            segments.push(`TRN${ELEMENT_SEPARATOR}1${ELEMENT_SEPARATOR}${claim.id || controlNumber}${ELEMENT_SEPARATOR}${controlNumber}`);

            // UM - Health Care Services Review Information
            segments.push(this.buildUM(claim));

            // HI - Diagnosis Codes
            const diagnosisSegments = this.buildHI(claim);
            segments.push(...diagnosisSegments);

            // SE - Transaction Set Trailer
            const segCount = segments.length - 2 + 1; // Exclude ISA, GS; include SE
            segments.push(`SE${ELEMENT_SEPARATOR}${segCount}${ELEMENT_SEPARATOR}${controlNumber}`);

            // GE - Functional Group Trailer
            segments.push(`GE${ELEMENT_SEPARATOR}1${ELEMENT_SEPARATOR}${controlNumber}`);

            // IEA - Interchange Control Trailer
            segments.push(`IEA${ELEMENT_SEPARATOR}1${ELEMENT_SEPARATOR}${controlNumber.padStart(9, '0')}`);

            const x12String = segments.join(SEGMENT_TERMINATOR) + SEGMENT_TERMINATOR;

            logInfo('FHIR to X12 278 translation completed', {
                claimId: claim.id,
                segmentCount: segments.length
            });

            return { x12String, segments };
        } catch (err) {
            logError('FHIR to X12 278 translation failed', { error: err });
            throw err;
        }
    }

    /**
     * Translate an X12 278 response to FHIR PAS Response Bundle
     * @param {string} x12Response
     * @returns {Promise<Object>} PAS Response Bundle
     */
    async x12_278ToFhir (x12Response) {
        try {
            const segments = x12Response.split(SEGMENT_TERMINATOR).filter(s => s.trim());
            const parsedSegments = segments.map(seg => {
                const elements = seg.split(ELEMENT_SEPARATOR);
                return { id: elements[0], elements };
            });

            // Build ClaimResponse from X12 278 response segments
            const aaa = parsedSegments.find(s => s.id === 'AAA');
            const hcr = parsedSegments.find(s => s.id === 'HCR');
            const trn = parsedSegments.find(s => s.id === 'TRN');

            // Determine outcome from HCR or AAA segments
            let outcome = 'queued'; // default to pended
            let disposition = 'Pending Review';

            if (hcr) {
                const actionCode = hcr.elements[1];
                switch (actionCode) {
                    case 'A1': outcome = 'complete'; disposition = 'Approved'; break;
                    case 'A2': outcome = 'complete'; disposition = 'Approved with Modification'; break;
                    case 'A3': outcome = 'error'; disposition = 'Denied'; break;
                    case 'A4': outcome = 'queued'; disposition = 'Pended'; break;
                    case 'A6': outcome = 'complete'; disposition = 'Cancelled'; break;
                    default: outcome = 'queued'; disposition = 'Pending'; break;
                }
            }

            const claimResponse = {
                resourceType: 'ClaimResponse',
                id: generateUUID(),
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
                preAuthRef: trn ? trn.elements[2] : undefined,
                created: new Date().toISOString()
            };

            const responseBundle = {
                resourceType: 'Bundle',
                id: generateUUID(),
                type: 'collection',
                timestamp: new Date().toISOString(),
                entry: [{
                    fullUrl: `urn:uuid:${claimResponse.id}`,
                    resource: claimResponse
                }]
            };

            logInfo('X12 278 to FHIR translation completed', {
                outcome,
                claimResponseId: claimResponse.id
            });

            return responseBundle;
        } catch (err) {
            logError('X12 278 to FHIR translation failed', { error: err });
            throw err;
        }
    }

    /**
     * Translate FHIR attachment to X12 275
     * @param {Object} attachmentBundle
     * @returns {Promise<{x12String: string}>}
     */
    async fhirToX12_275 (attachmentBundle) {
        const controlNumber = generateUUID().replace(/-/g, '').substring(0, 9);
        const segments = [];

        segments.push(this.buildISA(controlNumber));
        segments.push(this.buildGS(controlNumber));
        segments.push(`ST${ELEMENT_SEPARATOR}275${ELEMENT_SEPARATOR}${controlNumber}`);

        // BGN - Beginning Segment
        segments.push(`BGN${ELEMENT_SEPARATOR}02${ELEMENT_SEPARATOR}${controlNumber}${ELEMENT_SEPARATOR}${this.formatDate(new Date())}`);

        // NM1 - Payer
        segments.push(`NM1${ELEMENT_SEPARATOR}PR${ELEMENT_SEPARATOR}2`);

        // NM1 - Provider
        segments.push(`NM1${ELEMENT_SEPARATOR}1P${ELEMENT_SEPARATOR}2`);

        // TRN - Tracking Number
        const entries = attachmentBundle.entry || [];
        const trackingId = entries.find(e => e.resource?.resourceType === 'Parameters')
            ?.resource?.parameter?.find(p => p.name === 'TrackingId')?.valueString || controlNumber;
        segments.push(`TRN${ELEMENT_SEPARATOR}2${ELEMENT_SEPARATOR}${trackingId}`);

        // BIN - Binary Data
        const docRef = entries.find(e => e.resource?.resourceType === 'DocumentReference')?.resource;
        if (docRef?.content?.[0]?.attachment?.data) {
            const data = docRef.content[0].attachment.data;
            segments.push(`BIN${ELEMENT_SEPARATOR}${data.length}${ELEMENT_SEPARATOR}${data}`);
        }

        segments.push(`SE${ELEMENT_SEPARATOR}${segments.length - 2}${ELEMENT_SEPARATOR}${controlNumber}`);
        segments.push(`GE${ELEMENT_SEPARATOR}1${ELEMENT_SEPARATOR}${controlNumber}`);
        segments.push(`IEA${ELEMENT_SEPARATOR}1${ELEMENT_SEPARATOR}${controlNumber.padStart(9, '0')}`);

        return { x12String: segments.join(SEGMENT_TERMINATOR) + SEGMENT_TERMINATOR };
    }

    // --- Helper methods for building X12 segments ---

    buildISA (controlNumber) {
        const date = this.formatDate(new Date());
        const time = this.formatTime(new Date());
        return `ISA${ELEMENT_SEPARATOR}00${ELEMENT_SEPARATOR}          ${ELEMENT_SEPARATOR}00${ELEMENT_SEPARATOR}          ${ELEMENT_SEPARATOR}ZZ${ELEMENT_SEPARATOR}SENDER         ${ELEMENT_SEPARATOR}ZZ${ELEMENT_SEPARATOR}RECEIVER       ${ELEMENT_SEPARATOR}${date}${ELEMENT_SEPARATOR}${time}${ELEMENT_SEPARATOR}^${ELEMENT_SEPARATOR}00501${ELEMENT_SEPARATOR}${controlNumber.padStart(9, '0')}${ELEMENT_SEPARATOR}0${ELEMENT_SEPARATOR}P${ELEMENT_SEPARATOR}${SUB_ELEMENT_SEPARATOR}`;
    }

    buildGS (controlNumber) {
        const date = this.formatDateFull(new Date());
        const time = this.formatTimeFull(new Date());
        return `GS${ELEMENT_SEPARATOR}HI${ELEMENT_SEPARATOR}SENDER${ELEMENT_SEPARATOR}RECEIVER${ELEMENT_SEPARATOR}${date}${ELEMENT_SEPARATOR}${time}${ELEMENT_SEPARATOR}${controlNumber}${ELEMENT_SEPARATOR}X${ELEMENT_SEPARATOR}005010X217`;
    }

    buildBHT (claim, controlNumber) {
        const date = this.formatDateFull(new Date());
        const time = this.formatTimeFull(new Date());
        // 0007 = Request for Certification
        return `BHT${ELEMENT_SEPARATOR}0007${ELEMENT_SEPARATOR}11${ELEMENT_SEPARATOR}${controlNumber}${ELEMENT_SEPARATOR}${date}${ELEMENT_SEPARATOR}${time}`;
    }

    buildPayerNM1 (coverage) {
        const payerRef = coverage.payor?.[0]?.display || 'PAYER';
        return `NM1${ELEMENT_SEPARATOR}PR${ELEMENT_SEPARATOR}2${ELEMENT_SEPARATOR}${payerRef}`;
    }

    buildProviderNM1 (practitioner) {
        const lastName = practitioner.name?.[0]?.family || '';
        const firstName = practitioner.name?.[0]?.given?.[0] || '';
        const npi = practitioner.identifier?.find(
            id => id.system === 'http://hl7.org/fhir/sid/us-npi'
        )?.value || '';
        return `NM1${ELEMENT_SEPARATOR}1P${ELEMENT_SEPARATOR}1${ELEMENT_SEPARATOR}${lastName}${ELEMENT_SEPARATOR}${firstName}${ELEMENT_SEPARATOR}${ELEMENT_SEPARATOR}${ELEMENT_SEPARATOR}${ELEMENT_SEPARATOR}XX${ELEMENT_SEPARATOR}${npi}`;
    }

    buildPatientNM1 (patient) {
        const lastName = patient.name?.[0]?.family || '';
        const firstName = patient.name?.[0]?.given?.[0] || '';
        const memberId = patient.identifier?.[0]?.value || '';
        return `NM1${ELEMENT_SEPARATOR}IL${ELEMENT_SEPARATOR}1${ELEMENT_SEPARATOR}${lastName}${ELEMENT_SEPARATOR}${firstName}${ELEMENT_SEPARATOR}${ELEMENT_SEPARATOR}${ELEMENT_SEPARATOR}${ELEMENT_SEPARATOR}MI${ELEMENT_SEPARATOR}${memberId}`;
    }

    buildUM (claim) {
        // UM01: Request Category (HS=Health Services Review)
        // UM02: Certification Type (I=Initial)
        // UM03: Service Type Code
        const serviceType = claim.item?.[0]?.productOrService?.coding?.[0]?.code || '';
        return `UM${ELEMENT_SEPARATOR}HS${ELEMENT_SEPARATOR}I${ELEMENT_SEPARATOR}${serviceType}`;
    }

    buildHI (claim) {
        const segments = [];
        const diagnoses = claim.diagnosis || [];

        diagnoses.forEach((diag, index) => {
            const code = diag.diagnosisCodeableConcept?.coding?.[0]?.code || '';
            const qualifier = index === 0 ? 'ABK' : 'ABF'; // ABK=Principal, ABF=Admitting
            segments.push(`HI${ELEMENT_SEPARATOR}${qualifier}${SUB_ELEMENT_SEPARATOR}${code}`);
        });

        return segments;
    }

    formatDate (date) {
        return date.toISOString().slice(2, 10).replace(/-/g, '');
    }

    formatDateFull (date) {
        return date.toISOString().slice(0, 10).replace(/-/g, '');
    }

    formatTime (date) {
        return date.toISOString().slice(11, 16).replace(/:/g, '');
    }

    formatTimeFull (date) {
        return date.toISOString().slice(11, 19).replace(/:/g, '');
    }
}

module.exports = { BuiltInX12Adapter };
