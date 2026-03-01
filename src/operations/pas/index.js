/**
 * PAS (Prior Authorization Support) Module Exports
 *
 * Provides the Da Vinci PAS IG 2.1 operations for the FHIR server:
 *   - $submit - Submit a prior authorization request
 *   - $inquire - Check status of a previously submitted request
 *   - Bundle validation for PAS-specific profiles
 *
 * @see https://hl7.org/fhir/us/davinci-pas/STU2.1/
 */

const { PasSubmitOperation, PAS_RESPONSE_SLA_MS, PAS_REVIEW_ACTION } = require('./pasSubmitOperation');
const { PasInquireOperation, PAS_INQUIRE_SLA_MS } = require('./pasInquireOperation');
const { PasBundleValidator, PAS_PROFILES, ORDERED_ITEM_RESOURCE_TYPES } = require('./pasBundleValidator');

module.exports = {
    // Operations
    PasSubmitOperation,
    PasInquireOperation,

    // Validator
    PasBundleValidator,

    // Constants
    PAS_RESPONSE_SLA_MS,
    PAS_INQUIRE_SLA_MS,
    PAS_REVIEW_ACTION,
    PAS_PROFILES,
    ORDERED_ITEM_RESOURCE_TYPES
};
