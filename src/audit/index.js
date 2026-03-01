/**
 * Audit Module Exports
 *
 * Provides CMS-0057-F compliant audit logging capabilities for the
 * multi-tenant FHIR prior authorization platform.
 */
const { EnhancedAuditLogger } = require('./enhancedAuditLogger');
const {
    AuditEventBuilder,
    AUDIT_ACTION_CODES,
    AUDIT_TYPE_CODES,
    AUDIT_SUBTYPE_CODES,
    AUDIT_OUTCOME_CODES,
    AUDIT_SOURCE_TYPE_CODES,
    AUDIT_ENTITY_TYPE_CODES,
    AUDIT_ENTITY_ROLE_CODES,
    CORRELATION_EXTENSION_URL
} = require('./auditEventBuilder');

module.exports = {
    EnhancedAuditLogger,
    AuditEventBuilder,
    AUDIT_ACTION_CODES,
    AUDIT_TYPE_CODES,
    AUDIT_SUBTYPE_CODES,
    AUDIT_OUTCOME_CODES,
    AUDIT_SOURCE_TYPE_CODES,
    AUDIT_ENTITY_TYPE_CODES,
    AUDIT_ENTITY_ROLE_CODES,
    CORRELATION_EXTENSION_URL
};
