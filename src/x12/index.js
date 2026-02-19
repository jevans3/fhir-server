/**
 * X12 Translation Module Exports
 *
 * Provides the FHIR <-> X12 translation layer for the prior authorization platform:
 *   - X12TranslationAdapter - Abstract base class (plugin architecture)
 *   - BuiltInX12Adapter - Standard implementation for X12 278/275
 *   - Constants for transaction sets, delimiters, and action code mappings
 *
 * @see https://www.x12.org/products/transaction-sets
 */

const { X12TranslationAdapter, X12_TRANSACTION_SETS, X12_DELIMITERS } = require('./x12TranslationAdapter');
const { BuiltInX12Adapter, HCR_ACTION_CODE_MAP, CERTIFICATION_TYPE } = require('./builtInX12Adapter');

module.exports = {
    // Adapters
    X12TranslationAdapter,
    BuiltInX12Adapter,

    // Constants
    X12_TRANSACTION_SETS,
    X12_DELIMITERS,
    HCR_ACTION_CODE_MAP,
    CERTIFICATION_TYPE
};
