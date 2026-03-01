/**
 * TenantValidator - Validates tenant data for creation and updates
 */

const VALID_TENANT_TYPES = ['provider', 'payer', 'clearinghouse'];
const VALID_STATUSES = ['active', 'suspended', 'onboarding', 'decommissioned'];
const VALID_CONNECTION_TYPES = ['fhir_native', 'x12_clearinghouse', 'hybrid'];
const VALID_AUTH_METHODS = ['smart_backend_services', 'client_credentials', 'mutual_tls'];
const TENANT_ID_REGEX = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const NPI_REGEX = /^\d{10}$/;

class TenantValidator {
    /**
     * Validate tenant data for creation
     * @param {Object} tenantData
     * @returns {{ valid: boolean, errors: string[] }}
     */
    validateCreate (tenantData) {
        const errors = [];

        // Required fields
        if (!tenantData.tenantId) {
            errors.push('tenantId is required');
        } else if (!TENANT_ID_REGEX.test(tenantData.tenantId)) {
            errors.push('tenantId must be 3-63 characters, lowercase alphanumeric with hyphens, not starting/ending with hyphen');
        }

        if (!tenantData.displayName || tenantData.displayName.trim().length === 0) {
            errors.push('displayName is required');
        }

        if (!tenantData.tenantType) {
            errors.push('tenantType is required');
        } else if (!VALID_TENANT_TYPES.includes(tenantData.tenantType)) {
            errors.push(`tenantType must be one of: ${VALID_TENANT_TYPES.join(', ')}`);
        }

        // Organization validation
        if (!tenantData.organization) {
            errors.push('organization is required');
        } else {
            if (!tenantData.organization.npi) {
                errors.push('organization.npi is required');
            } else if (!NPI_REGEX.test(tenantData.organization.npi)) {
                errors.push('organization.npi must be a 10-digit number');
            }
        }

        return { valid: errors.length === 0, errors };
    }

    /**
     * Validate tenant data for updates
     * @param {Object} updateData
     * @returns {{ valid: boolean, errors: string[] }}
     */
    validateUpdate (updateData) {
        const errors = [];

        if (updateData.tenantId) {
            errors.push('tenantId cannot be changed after creation');
        }

        if (updateData.tenantType && !VALID_TENANT_TYPES.includes(updateData.tenantType)) {
            errors.push(`tenantType must be one of: ${VALID_TENANT_TYPES.join(', ')}`);
        }

        if (updateData.status && !VALID_STATUSES.includes(updateData.status)) {
            errors.push(`status must be one of: ${VALID_STATUSES.join(', ')}`);
        }

        return { valid: errors.length === 0, errors };
    }

    /**
     * Validate payer connection data
     * @param {Object} connectionData
     * @returns {{ valid: boolean, errors: string[] }}
     */
    validatePayerConnection (connectionData) {
        const errors = [];

        if (!connectionData.payerTenantId) {
            errors.push('payerTenantId is required');
        }

        if (!connectionData.connectionType) {
            errors.push('connectionType is required');
        } else if (!VALID_CONNECTION_TYPES.includes(connectionData.connectionType)) {
            errors.push(`connectionType must be one of: ${VALID_CONNECTION_TYPES.join(', ')}`);
        }

        if (!connectionData.endpoints) {
            errors.push('endpoints configuration is required');
        }

        if (connectionData.credentials) {
            if (!connectionData.credentials.authMethod) {
                errors.push('credentials.authMethod is required');
            } else if (!VALID_AUTH_METHODS.includes(connectionData.credentials.authMethod)) {
                errors.push(`credentials.authMethod must be one of: ${VALID_AUTH_METHODS.join(', ')}`);
            }
        }

        return { valid: errors.length === 0, errors };
    }
}

module.exports = { TenantValidator };
