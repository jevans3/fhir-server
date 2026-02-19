/**
 * X12TranslationAdapter - Base adapter interface for FHIR <-> X12 translation
 *
 * Plugin architecture: supports built-in and external clearinghouse adapters.
 * Per CMS-0057-F, X12 278 compatibility must be maintained on the payer side,
 * though CMS enforcement discretion allows all-FHIR PA flows.
 */

class X12TranslationAdapter {
    /**
     * Translate a PAS FHIR Request Bundle to X12 278 format
     * @param {Object} pasRequestBundle - FHIR Bundle with Claim (use=preauthorization)
     * @returns {Promise<{x12String: string, segments: Object[]}>}
     */
    async fhirToX12_278 (pasRequestBundle) {
        throw new Error('fhirToX12_278 must be implemented by subclass');
    }

    /**
     * Translate an X12 278 response to FHIR PAS Response Bundle
     * @param {string} x12Response - X12 278 response string
     * @returns {Promise<Object>} PAS Response Bundle
     */
    async x12_278ToFhir (x12Response) {
        throw new Error('x12_278ToFhir must be implemented by subclass');
    }

    /**
     * Translate FHIR attachment data to X12 275 format
     * @param {Object} attachmentBundle - FHIR Bundle with DocumentReference
     * @returns {Promise<{x12String: string}>}
     */
    async fhirToX12_275 (attachmentBundle) {
        throw new Error('fhirToX12_275 must be implemented by subclass');
    }

    /**
     * Create a Provenance resource documenting the translation
     * @param {Object} original - Original resource (FHIR or X12)
     * @param {Object} translated - Translated resource
     * @param {string} direction - 'fhir-to-x12' or 'x12-to-fhir'
     * @returns {Object} FHIR Provenance resource
     */
    createProvenance (original, translated, direction) {
        const now = new Date().toISOString();

        return {
            resourceType: 'Provenance',
            target: [{
                reference: translated.resourceType
                    ? `${translated.resourceType}/${translated.id}`
                    : 'Binary/x12-translation'
            }],
            recorded: now,
            activity: {
                coding: [{
                    system: 'http://terminology.hl7.org/CodeSystem/v3-DataOperation',
                    code: 'TRANS',
                    display: 'Transform/Translate'
                }]
            },
            agent: [{
                type: {
                    coding: [{
                        system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type',
                        code: 'assembler',
                        display: 'Assembler'
                    }]
                },
                who: {
                    display: 'FHIR Prior Authorization Platform - X12 Translation Engine'
                }
            }],
            entity: [{
                role: 'source',
                what: {
                    display: `${direction === 'fhir-to-x12' ? 'FHIR PAS Bundle' : 'X12 278 Transaction'}`
                }
            }]
        };
    }
}

module.exports = { X12TranslationAdapter };
