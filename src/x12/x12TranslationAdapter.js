/**
 * X12 Translation Adapter - Base Interface/Class
 *
 * Provides the abstract interface for translating between FHIR resources and
 * X12 EDI transaction sets used in prior authorization workflows.
 *
 * Supported translations:
 *   - FHIR Claim Bundle  <->  X12 278 (Health Care Services Review Request/Response)
 *   - FHIR DocumentReference/Binary  <->  X12 275 (Additional Information to Support a Health Care Claim)
 *
 * This class is designed as a plugin architecture base. Implementations can:
 *   - Use the built-in adapter (BuiltInX12Adapter) for standard mappings
 *   - Register custom adapters for payer-specific translation requirements
 *   - Chain adapters for pre/post-processing
 *
 * All translations must produce a Provenance resource documenting the transformation
 * per the Da Vinci PAS IG requirements.
 *
 * @see https://hl7.org/fhir/us/davinci-pas/STU2.1/specification.html
 * @see https://www.x12.org/products/transaction-sets (278, 275)
 */

/**
 * X12 transaction set identifiers
 * @readonly
 * @enum {string}
 */
const X12_TRANSACTION_SETS = Object.freeze({
    /** Health Care Services Review - Request */
    TS_278_REQUEST: '278-request',
    /** Health Care Services Review - Response */
    TS_278_RESPONSE: '278-response',
    /** Additional Information to Support a Health Care Claim or Encounter */
    TS_275: '275'
});

/**
 * X12 segment delimiters
 * @readonly
 * @enum {string}
 */
const X12_DELIMITERS = Object.freeze({
    /** Segment terminator */
    SEGMENT: '~',
    /** Data element separator */
    ELEMENT: '*',
    /** Component element separator */
    COMPONENT: ':',
    /** Repetition separator */
    REPETITION: '^'
});

/**
 * @typedef {Object} TranslationContext
 * @property {string} [platformTrackingId] - Platform tracking ID for this transaction
 * @property {Object} [payerIdentifier] - Payer identifier (NPI, Tax ID, etc.)
 * @property {Object} [connectionConfig] - Payer connection configuration
 * @property {string} [senderApplicationId] - Sending application identifier
 * @property {string} [receiverApplicationId] - Receiving application identifier
 * @property {string} [transactionSetPurpose] - Purpose code (e.g., 'HS' for request, 'HI' for inquiry)
 * @property {Object} [metadata] - Additional metadata for the translation
 */

/**
 * @typedef {Object} TranslationResult
 * @property {string} x12Data - The raw X12 EDI string
 * @property {Object[]} segments - Parsed segment objects
 * @property {Object} metadata - Translation metadata
 * @property {number} metadata.segmentCount - Number of X12 segments produced
 * @property {string} metadata.transactionSet - Transaction set identifier
 * @property {string} metadata.controlNumber - ISA/GS control number
 * @property {string[]} metadata.warnings - Non-fatal translation warnings
 */

/**
 * @typedef {Object} ReverseTranslationResult
 * @property {Object} bundle - The FHIR Bundle produced from X12
 * @property {Object} provenance - Provenance resource documenting the translation
 * @property {Object} metadata - Translation metadata
 * @property {string[]} metadata.warnings - Non-fatal translation warnings
 * @property {string[]} metadata.unmappedSegments - X12 segments that could not be mapped
 */

class X12TranslationAdapter {
    /**
     * @param {Object} [options]
     * @param {string} [options.adapterId] - Unique identifier for this adapter instance
     * @param {string} [options.adapterVersion] - Version of this adapter
     */
    constructor (options = {}) {
        /**
         * Unique identifier for this adapter
         * @type {string}
         */
        this.adapterId = options.adapterId || 'base';

        /**
         * Adapter version for Provenance tracking
         * @type {string}
         */
        this.adapterVersion = options.adapterVersion || '1.0.0';

        if (new.target === X12TranslationAdapter) {
            throw new Error(
                'X12TranslationAdapter is an abstract class and cannot be instantiated directly. ' +
                'Use a concrete implementation such as BuiltInX12Adapter.'
            );
        }
    }

    /**
     * Translates a FHIR PAS Request Bundle to an X12 278 transaction set
     * (Health Care Services Review - Request for Review)
     *
     * @param {Object} fhirBundle - The PAS Request Bundle containing Claim and supporting resources
     * @param {TranslationContext} [context] - Additional context for the translation
     * @returns {Promise<TranslationResult>} The X12 278 request data with metadata
     * @throws {Error} If the bundle cannot be translated
     * @abstract
     */
    async fhirToX12_278 (fhirBundle, context = {}) {
        throw new Error(
            'fhirToX12_278() must be implemented by a concrete X12TranslationAdapter subclass'
        );
    }

    /**
     * Translates an X12 278 response transaction set back to a FHIR PAS Response Bundle
     * (Health Care Services Review - Response)
     *
     * @param {string} x12Data - The raw X12 278 response EDI string
     * @param {TranslationContext} [context] - Additional context for the translation
     * @returns {Promise<ReverseTranslationResult>} The FHIR PAS Response Bundle with Provenance
     * @throws {Error} If the X12 data cannot be translated
     * @abstract
     */
    async x12_278ToFhir (x12Data, context = {}) {
        throw new Error(
            'x12_278ToFhir() must be implemented by a concrete X12TranslationAdapter subclass'
        );
    }

    /**
     * Translates a FHIR DocumentReference/Binary to an X12 275 transaction set
     * (Additional Information to Support a Health Care Claim)
     *
     * Used when additional clinical documentation needs to be sent to the payer
     * as part of the prior authorization workflow (e.g., via CDex).
     *
     * @param {Object} fhirResources - Object containing { documentReference, binary, claim }
     * @param {Object} [fhirResources.documentReference] - The DocumentReference resource
     * @param {Object} [fhirResources.binary] - The Binary resource with the document content
     * @param {Object} [fhirResources.claim] - The related Claim for reference linking
     * @param {TranslationContext} [context] - Additional context for the translation
     * @returns {Promise<TranslationResult>} The X12 275 data with metadata
     * @throws {Error} If the resources cannot be translated
     * @abstract
     */
    async fhirToX12_275 (fhirResources, context = {}) {
        throw new Error(
            'fhirToX12_275() must be implemented by a concrete X12TranslationAdapter subclass'
        );
    }

    /**
     * Creates a FHIR Provenance resource documenting a FHIR-to-X12 or X12-to-FHIR translation.
     *
     * Per the PAS IG, when X12 translation occurs, a Provenance resource must be created
     * to document the transformation for auditability.
     *
     * @param {Object} sourceResource - The source FHIR resource or bundle that was translated
     * @param {Object} targetResource - The target FHIR resource or bundle produced
     * @param {Object} [options] - Additional Provenance options
     * @param {string} [options.translationDirection] - 'fhir-to-x12' or 'x12-to-fhir'
     * @param {string} [options.transactionSet] - X12 transaction set (e.g., '278', '275')
     * @param {string} [options.platformTrackingId] - Platform tracking ID
     * @param {string[]} [options.warnings] - Translation warnings to include
     * @returns {Object} FHIR Provenance resource
     * @abstract
     */
    createProvenance (sourceResource, targetResource, options = {}) {
        throw new Error(
            'createProvenance() must be implemented by a concrete X12TranslationAdapter subclass'
        );
    }

    /**
     * Returns the adapter identifier for logging and Provenance tracking
     * @returns {string}
     */
    getAdapterId () {
        return this.adapterId;
    }

    /**
     * Returns the adapter version for Provenance tracking
     * @returns {string}
     */
    getAdapterVersion () {
        return this.adapterVersion;
    }

    /**
     * Validates that the adapter is properly configured and ready for use
     * @returns {{valid: boolean, errors: string[]}}
     */
    validate () {
        const errors = [];

        if (!this.adapterId) {
            errors.push('adapterId is required');
        }

        if (!this.adapterVersion) {
            errors.push('adapterVersion is required');
        }

        return { valid: errors.length === 0, errors };
    }
}

module.exports = {
    X12TranslationAdapter,
    X12_TRANSACTION_SETS,
    X12_DELIMITERS
};
