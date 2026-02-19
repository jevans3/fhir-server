/**
 * PAS Bundle Validator
 *
 * Validates PAS Request Bundles per the Da Vinci Prior Authorization Support
 * Implementation Guide (PAS IG 2.1). Ensures that submitted bundles contain
 * all required resources and conform to PAS profile constraints.
 *
 * Required resources in a PAS Request Bundle:
 *   - Claim (use = preauthorization)
 *   - Patient
 *   - Coverage
 *   - At least one ordered item (ServiceRequest, DeviceRequest, or MedicationRequest)
 *
 * @see https://hl7.org/fhir/us/davinci-pas/STU2.1/StructureDefinition-profile-pas-request-bundle.html
 */

const { logInfo, logError } = require('../common/logging');

/**
 * PAS Profile URLs per the Da Vinci PAS IG 2.1
 * @readonly
 * @enum {string}
 */
const PAS_PROFILES = Object.freeze({
    REQUEST_BUNDLE: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-pas-request-bundle',
    RESPONSE_BUNDLE: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-pas-response-bundle',
    INQUIRY_REQUEST_BUNDLE: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-pas-inquiry-request-bundle',
    INQUIRY_RESPONSE_BUNDLE: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-pas-inquiry-response-bundle',
    CLAIM: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-claim',
    CLAIM_UPDATE: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-claim-update',
    CLAIM_INQUIRY: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-claim-inquiry',
    CLAIM_RESPONSE: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-claimresponse',
    COVERAGE: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-coverage',
    PATIENT: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-beneficiary',
    SUBSCRIBER: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-subscriber'
});

/**
 * Resource types considered as ordered items in PAS
 * @type {string[]}
 */
const ORDERED_ITEM_RESOURCE_TYPES = [
    'ServiceRequest',
    'DeviceRequest',
    'MedicationRequest'
];

/**
 * @typedef {Object} ValidationIssue
 * @property {'error'|'warning'|'information'} severity
 * @property {string} code - OperationOutcome issue code
 * @property {string} details - Human-readable description of the issue
 * @property {string} [expression] - FHIRPath expression pointing to the issue location
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Whether the bundle passes validation
 * @property {ValidationIssue[]} issues - Detailed list of validation issues
 * @property {Object} [extractedReferences] - Key resource references extracted during validation
 * @property {string} [extractedReferences.claimId] - The Claim resource ID
 * @property {string} [extractedReferences.patientReference] - Reference to the Patient
 * @property {string} [extractedReferences.coverageReference] - Reference to the Coverage
 * @property {string} [extractedReferences.payorReference] - Reference to the insurer/payor
 * @property {string[]} [extractedReferences.orderedItemReferences] - References to ordered items
 */

class PasBundleValidator {
    constructor () {
        /**
         * Validation pass counter for diagnostics
         * @type {number}
         */
        this.validationCount = 0;
    }

    /**
     * Validates a PAS Request Bundle for the $submit operation
     * @param {Object} bundle - The PAS Request Bundle to validate
     * @returns {ValidationResult}
     */
    validateSubmitBundle (bundle) {
        this.validationCount++;
        /** @type {ValidationIssue[]} */
        const issues = [];

        // 1. Validate top-level Bundle structure
        this._validateBundleStructure(bundle, issues);

        if (issues.some(i => i.severity === 'error')) {
            return { valid: false, issues };
        }

        // 2. Build resource index from bundle entries
        const resourceIndex = this._buildResourceIndex(bundle, issues);

        // 3. Validate required Claim resource
        const claimEntry = this._validateClaimPresence(resourceIndex, issues);

        // 4. Validate Claim.use = preauthorization
        if (claimEntry) {
            this._validateClaimUse(claimEntry, issues);
        }

        // 5. Validate required Patient resource
        this._validatePatientPresence(resourceIndex, claimEntry, issues);

        // 6. Validate required Coverage resource
        this._validateCoveragePresence(resourceIndex, claimEntry, issues);

        // 7. Validate at least one ordered item (ServiceRequest/DeviceRequest/MedicationRequest)
        this._validateOrderedItemPresence(resourceIndex, issues);

        // 8. Validate Claim profile constraints
        if (claimEntry) {
            this._validateClaimProfileConstraints(claimEntry, issues);
        }

        // 9. Extract references for downstream use
        const extractedReferences = claimEntry
            ? this._extractReferences(claimEntry, resourceIndex)
            : {};

        const valid = !issues.some(i => i.severity === 'error');

        logInfo('PAS Bundle validation completed', {
            valid,
            errorCount: issues.filter(i => i.severity === 'error').length,
            warningCount: issues.filter(i => i.severity === 'warning').length,
            validationNumber: this.validationCount
        });

        return { valid, issues, extractedReferences };
    }

    /**
     * Validates a PAS Inquiry Bundle for the $inquire operation
     * @param {Object} bundle - The PAS Inquiry Request Bundle to validate
     * @returns {ValidationResult}
     */
    validateInquiryBundle (bundle) {
        this.validationCount++;
        /** @type {ValidationIssue[]} */
        const issues = [];

        // 1. Validate top-level Bundle structure
        this._validateBundleStructure(bundle, issues);

        if (issues.some(i => i.severity === 'error')) {
            return { valid: false, issues };
        }

        // 2. Build resource index from bundle entries
        const resourceIndex = this._buildResourceIndex(bundle, issues);

        // 3. Validate required Claim resource for inquiry
        const claimEntry = this._validateClaimPresence(resourceIndex, issues);

        // 4. Validate Claim.use = preauthorization
        if (claimEntry) {
            this._validateClaimUse(claimEntry, issues);
        }

        // 5. Validate required Patient resource
        this._validatePatientPresence(resourceIndex, claimEntry, issues);

        // 6. Validate required Coverage resource
        this._validateCoveragePresence(resourceIndex, claimEntry, issues);

        const extractedReferences = claimEntry
            ? this._extractReferences(claimEntry, resourceIndex)
            : {};

        const valid = !issues.some(i => i.severity === 'error');

        return { valid, issues, extractedReferences };
    }

    /**
     * Validates the top-level Bundle structure
     * @param {Object} bundle
     * @param {ValidationIssue[]} issues
     * @private
     */
    _validateBundleStructure (bundle, issues) {
        if (!bundle) {
            issues.push({
                severity: 'error',
                code: 'required',
                details: 'Request body is empty or null'
            });
            return;
        }

        if (bundle.resourceType !== 'Bundle') {
            issues.push({
                severity: 'error',
                code: 'invalid',
                details: `Expected resourceType "Bundle" but received "${bundle.resourceType}"`,
                expression: 'Bundle.resourceType'
            });
            return;
        }

        if (bundle.type !== 'collection') {
            issues.push({
                severity: 'error',
                code: 'value',
                details: `PAS Request Bundle must have type "collection", received "${bundle.type}"`,
                expression: 'Bundle.type'
            });
        }

        if (!bundle.entry || !Array.isArray(bundle.entry) || bundle.entry.length === 0) {
            issues.push({
                severity: 'error',
                code: 'required',
                details: 'PAS Request Bundle must contain at least one entry',
                expression: 'Bundle.entry'
            });
        }
    }

    /**
     * Builds a resource index from bundle entries for O(1) lookups
     * @param {Object} bundle
     * @param {ValidationIssue[]} issues
     * @returns {Map<string, Object[]>} Map of resourceType -> resource array
     * @private
     */
    _buildResourceIndex (bundle, issues) {
        /** @type {Map<string, Object[]>} */
        const index = new Map();

        if (!bundle.entry) {
            return index;
        }

        for (let i = 0; i < bundle.entry.length; i++) {
            const entry = bundle.entry[i];

            if (!entry.resource) {
                issues.push({
                    severity: 'warning',
                    code: 'incomplete',
                    details: `Bundle entry at index ${i} has no resource`,
                    expression: `Bundle.entry[${i}].resource`
                });
                continue;
            }

            const resourceType = entry.resource.resourceType;
            if (!resourceType) {
                issues.push({
                    severity: 'error',
                    code: 'invalid',
                    details: `Resource at entry index ${i} is missing resourceType`,
                    expression: `Bundle.entry[${i}].resource.resourceType`
                });
                continue;
            }

            if (!index.has(resourceType)) {
                index.set(resourceType, []);
            }
            index.get(resourceType).push(entry.resource);
        }

        return index;
    }

    /**
     * Validates that a Claim resource is present in the bundle
     * @param {Map<string, Object[]>} resourceIndex
     * @param {ValidationIssue[]} issues
     * @returns {Object|null} The Claim resource if found
     * @private
     */
    _validateClaimPresence (resourceIndex, issues) {
        const claims = resourceIndex.get('Claim');

        if (!claims || claims.length === 0) {
            issues.push({
                severity: 'error',
                code: 'required',
                details: 'PAS Request Bundle must contain a Claim resource',
                expression: 'Bundle.entry.resource.where(resourceType=\'Claim\')'
            });
            return null;
        }

        if (claims.length > 1) {
            issues.push({
                severity: 'error',
                code: 'business-rule',
                details: `PAS Request Bundle must contain exactly one Claim resource, found ${claims.length}`,
                expression: 'Bundle.entry.resource.where(resourceType=\'Claim\')'
            });
        }

        return claims[0];
    }

    /**
     * Validates Claim.use is set to 'preauthorization'
     * @param {Object} claim
     * @param {ValidationIssue[]} issues
     * @private
     */
    _validateClaimUse (claim, issues) {
        if (!claim.use) {
            issues.push({
                severity: 'error',
                code: 'required',
                details: 'Claim.use is required and must be "preauthorization"',
                expression: 'Claim.use'
            });
            return;
        }

        if (claim.use !== 'preauthorization') {
            issues.push({
                severity: 'error',
                code: 'value',
                details: `Claim.use must be "preauthorization" for PAS, received "${claim.use}"`,
                expression: 'Claim.use'
            });
        }
    }

    /**
     * Validates that a Patient resource is present and referenced by the Claim
     * @param {Map<string, Object[]>} resourceIndex
     * @param {Object|null} claim
     * @param {ValidationIssue[]} issues
     * @private
     */
    _validatePatientPresence (resourceIndex, claim, issues) {
        const patients = resourceIndex.get('Patient');

        if (!patients || patients.length === 0) {
            issues.push({
                severity: 'error',
                code: 'required',
                details: 'PAS Request Bundle must contain a Patient resource (the beneficiary)',
                expression: 'Bundle.entry.resource.where(resourceType=\'Patient\')'
            });
            return;
        }

        // Validate Claim.patient reference points to a Patient in the bundle
        if (claim && claim.patient) {
            const patientRef = claim.patient.reference;
            if (patientRef) {
                const refId = this._extractIdFromReference(patientRef);
                const found = patients.some(p => p.id === refId);
                if (!found) {
                    issues.push({
                        severity: 'error',
                        code: 'reference',
                        details: `Claim.patient reference "${patientRef}" does not resolve to a Patient in the bundle`,
                        expression: 'Claim.patient'
                    });
                }
            }
        } else if (claim) {
            issues.push({
                severity: 'error',
                code: 'required',
                details: 'Claim.patient is required',
                expression: 'Claim.patient'
            });
        }
    }

    /**
     * Validates that a Coverage resource is present and referenced by the Claim
     * @param {Map<string, Object[]>} resourceIndex
     * @param {Object|null} claim
     * @param {ValidationIssue[]} issues
     * @private
     */
    _validateCoveragePresence (resourceIndex, claim, issues) {
        const coverages = resourceIndex.get('Coverage');

        if (!coverages || coverages.length === 0) {
            issues.push({
                severity: 'error',
                code: 'required',
                details: 'PAS Request Bundle must contain a Coverage resource',
                expression: 'Bundle.entry.resource.where(resourceType=\'Coverage\')'
            });
            return;
        }

        // Validate Claim.insurance[0].coverage reference points to a Coverage in the bundle
        if (claim && claim.insurance && Array.isArray(claim.insurance) && claim.insurance.length > 0) {
            const coverageRef = claim.insurance[0].coverage && claim.insurance[0].coverage.reference;
            if (coverageRef) {
                const refId = this._extractIdFromReference(coverageRef);
                const found = coverages.some(c => c.id === refId);
                if (!found) {
                    issues.push({
                        severity: 'error',
                        code: 'reference',
                        details: `Claim.insurance[0].coverage reference "${coverageRef}" does not resolve to a Coverage in the bundle`,
                        expression: 'Claim.insurance[0].coverage'
                    });
                }
            }
        } else if (claim) {
            issues.push({
                severity: 'error',
                code: 'required',
                details: 'Claim.insurance is required with at least one entry containing a coverage reference',
                expression: 'Claim.insurance'
            });
        }
    }

    /**
     * Validates at least one ordered item (ServiceRequest, DeviceRequest, or MedicationRequest)
     * is present in the bundle
     * @param {Map<string, Object[]>} resourceIndex
     * @param {ValidationIssue[]} issues
     * @private
     */
    _validateOrderedItemPresence (resourceIndex, issues) {
        let orderedItemCount = 0;

        for (const resourceType of ORDERED_ITEM_RESOURCE_TYPES) {
            const items = resourceIndex.get(resourceType);
            if (items) {
                orderedItemCount += items.length;
            }
        }

        if (orderedItemCount === 0) {
            issues.push({
                severity: 'error',
                code: 'required',
                details: 'PAS Request Bundle must contain at least one ordered item ' +
                    '(ServiceRequest, DeviceRequest, or MedicationRequest)',
                expression: 'Bundle.entry.resource'
            });
        }
    }

    /**
     * Validates Claim profile constraints per the PAS IG
     * @param {Object} claim
     * @param {ValidationIssue[]} issues
     * @private
     */
    _validateClaimProfileConstraints (claim, issues) {
        // Claim.status must be 'active'
        if (!claim.status) {
            issues.push({
                severity: 'error',
                code: 'required',
                details: 'Claim.status is required',
                expression: 'Claim.status'
            });
        } else if (claim.status !== 'active') {
            issues.push({
                severity: 'error',
                code: 'value',
                details: `Claim.status must be "active" for a new PA request, received "${claim.status}"`,
                expression: 'Claim.status'
            });
        }

        // Claim.type is required (institutional or professional)
        if (!claim.type || !claim.type.coding || !Array.isArray(claim.type.coding) || claim.type.coding.length === 0) {
            issues.push({
                severity: 'error',
                code: 'required',
                details: 'Claim.type is required with at least one coding (institutional or professional)',
                expression: 'Claim.type'
            });
        }

        // Claim.provider is required
        if (!claim.provider || !claim.provider.reference) {
            issues.push({
                severity: 'error',
                code: 'required',
                details: 'Claim.provider is required with a reference to the requesting provider',
                expression: 'Claim.provider'
            });
        }

        // Claim.insurer is required
        if (!claim.insurer || !claim.insurer.reference) {
            issues.push({
                severity: 'error',
                code: 'required',
                details: 'Claim.insurer is required with a reference to the payer organization',
                expression: 'Claim.insurer'
            });
        }

        // Claim.priority is required
        if (!claim.priority || !claim.priority.coding || !Array.isArray(claim.priority.coding)) {
            issues.push({
                severity: 'warning',
                code: 'required',
                details: 'Claim.priority is recommended per PAS IG',
                expression: 'Claim.priority'
            });
        }

        // Claim.created is required
        if (!claim.created) {
            issues.push({
                severity: 'error',
                code: 'required',
                details: 'Claim.created is required',
                expression: 'Claim.created'
            });
        }

        // Validate supportingInfo if present
        if (claim.supportingInfo && Array.isArray(claim.supportingInfo)) {
            for (let i = 0; i < claim.supportingInfo.length; i++) {
                const info = claim.supportingInfo[i];
                if (!info.sequence) {
                    issues.push({
                        severity: 'error',
                        code: 'required',
                        details: `Claim.supportingInfo[${i}].sequence is required`,
                        expression: `Claim.supportingInfo[${i}].sequence`
                    });
                }
                if (!info.category) {
                    issues.push({
                        severity: 'error',
                        code: 'required',
                        details: `Claim.supportingInfo[${i}].category is required`,
                        expression: `Claim.supportingInfo[${i}].category`
                    });
                }
            }
        }

        // Validate item[].extension for item trace number (PAS-specific)
        if (claim.item && Array.isArray(claim.item)) {
            for (let i = 0; i < claim.item.length; i++) {
                const item = claim.item[i];
                if (!item.sequence) {
                    issues.push({
                        severity: 'error',
                        code: 'required',
                        details: `Claim.item[${i}].sequence is required`,
                        expression: `Claim.item[${i}].sequence`
                    });
                }
                if (!item.productOrService) {
                    issues.push({
                        severity: 'error',
                        code: 'required',
                        details: `Claim.item[${i}].productOrService is required`,
                        expression: `Claim.item[${i}].productOrService`
                    });
                }
            }
        } else {
            issues.push({
                severity: 'error',
                code: 'required',
                details: 'Claim.item is required with at least one entry',
                expression: 'Claim.item'
            });
        }
    }

    /**
     * Extracts key references from the Claim resource for downstream routing and storage
     * @param {Object} claim
     * @param {Map<string, Object[]>} resourceIndex
     * @returns {Object} Extracted references
     * @private
     */
    _extractReferences (claim, resourceIndex) {
        const refs = {
            claimId: claim.id || null,
            patientReference: claim.patient && claim.patient.reference ? claim.patient.reference : null,
            coverageReference: null,
            payorReference: claim.insurer && claim.insurer.reference ? claim.insurer.reference : null,
            providerReference: claim.provider && claim.provider.reference ? claim.provider.reference : null,
            orderedItemReferences: []
        };

        // Extract coverage reference from insurance
        if (claim.insurance && Array.isArray(claim.insurance) && claim.insurance.length > 0) {
            refs.coverageReference = claim.insurance[0].coverage && claim.insurance[0].coverage.reference
                ? claim.insurance[0].coverage.reference
                : null;
        }

        // Extract payor from Coverage.payor if available
        const coverages = resourceIndex.get('Coverage');
        if (coverages && coverages.length > 0) {
            const coverage = coverages[0];
            if (coverage.payor && Array.isArray(coverage.payor) && coverage.payor.length > 0) {
                refs.payorReference = coverage.payor[0].reference || refs.payorReference;
            }
        }

        // Collect ordered item references from Claim.item extensions or supportingInfo
        for (const resourceType of ORDERED_ITEM_RESOURCE_TYPES) {
            const items = resourceIndex.get(resourceType);
            if (items) {
                for (const item of items) {
                    refs.orderedItemReferences.push(`${resourceType}/${item.id}`);
                }
            }
        }

        return refs;
    }

    /**
     * Extracts the resource ID from a FHIR reference string
     * @param {string} reference - e.g. "Patient/123" or "urn:uuid:abc-def"
     * @returns {string} The extracted ID
     * @private
     */
    _extractIdFromReference (reference) {
        if (!reference) {
            return '';
        }

        // Handle urn:uuid references
        if (reference.startsWith('urn:uuid:')) {
            return reference.substring('urn:uuid:'.length);
        }

        // Handle relative references (e.g., "Patient/123")
        const parts = reference.split('/');
        return parts.length > 1 ? parts[parts.length - 1] : reference;
    }

    /**
     * Returns the PAS profile constants for external use
     * @returns {Readonly<Object>}
     */
    static getProfiles () {
        return PAS_PROFILES;
    }
}

module.exports = {
    PasBundleValidator,
    PAS_PROFILES,
    ORDERED_ITEM_RESOURCE_TYPES
};
