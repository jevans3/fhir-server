/**
 * TenantContext - Request-scoped tenant context holder
 * Stores tenant information for the duration of a request lifecycle
 */
const { assertIsValid } = require('../utils/assertType');

/**
 * @typedef TenantContextData
 * @property {string} tenantId - URL-safe tenant slug
 * @property {string} tenantType - 'provider' | 'payer' | 'clearinghouse'
 * @property {string} displayName - Human-readable tenant name
 * @property {string} status - 'active' | 'suspended' | 'onboarding' | 'decommissioned'
 * @property {Object} database - Database configuration for this tenant
 * @property {Object} auth - Auth configuration for this tenant
 * @property {Object} features - Feature flags for this tenant
 * @property {Object} compliance - Compliance metadata
 */

class TenantContext {
    /**
     * @param {TenantContextData} params
     */
    constructor ({
        tenantId,
        tenantType,
        displayName,
        status,
        database,
        auth,
        features,
        compliance,
        organization,
        connectedPayers,
        connectedProviders
    }) {
        assertIsValid(tenantId, 'tenantId is required');
        assertIsValid(tenantType, 'tenantType is required');

        /** @type {string} */
        this.tenantId = tenantId;
        /** @type {string} */
        this.tenantType = tenantType;
        /** @type {string} */
        this.displayName = displayName;
        /** @type {string} */
        this.status = status;
        /** @type {Object} */
        this.database = database || {};
        /** @type {Object} */
        this.auth = auth || {};
        /** @type {Object} */
        this.features = features || {};
        /** @type {Object} */
        this.compliance = compliance || {};
        /** @type {Object} */
        this.organization = organization || {};
        /** @type {Array} */
        this.connectedPayers = connectedPayers || [];
        /** @type {Array} */
        this.connectedProviders = connectedProviders || [];
    }

    /**
     * Whether this tenant is active and can process requests
     * @returns {boolean}
     */
    isActive () {
        return this.status === 'active';
    }

    /**
     * Whether this tenant is a provider type
     * @returns {boolean}
     */
    isProvider () {
        return this.tenantType === 'provider';
    }

    /**
     * Whether this tenant is a payer type
     * @returns {boolean}
     */
    isPayer () {
        return this.tenantType === 'payer';
    }

    /**
     * Whether a specific feature is enabled for this tenant
     * @param {string} featureName
     * @returns {boolean}
     */
    isFeatureEnabled (featureName) {
        return this.features[featureName] === true;
    }

    /**
     * Get the database name for this tenant's FHIR data
     * @returns {string}
     */
    getFhirDbName () {
        return this.database.name || `fhir_${this.tenantId.replace(/-/g, '_')}`;
    }

    /**
     * Get the database name for this tenant's audit data
     * @returns {string}
     */
    getAuditDbName () {
        return this.database.auditDbName || `audit_${this.tenantId.replace(/-/g, '_')}`;
    }

    /**
     * Get the database name for this tenant's history data
     * @returns {string}
     */
    getHistoryDbName () {
        return this.database.historyDbName || `history_${this.tenantId.replace(/-/g, '_')}`;
    }

    /**
     * Find a connected payer configuration by payer tenant ID
     * @param {string} payerTenantId
     * @returns {Object|null}
     */
    getPayerConnection (payerTenantId) {
        return this.connectedPayers.find(p => p.payerTenantId === payerTenantId) || null;
    }

    /**
     * Find a connected provider configuration by provider tenant ID
     * @param {string} providerTenantId
     * @returns {Object|null}
     */
    getProviderConnection (providerTenantId) {
        return this.connectedProviders.find(p => p.providerTenantId === providerTenantId) || null;
    }

    /**
     * Serialize to a plain object for logging (excludes sensitive data)
     * @returns {Object}
     */
    toLogSafe () {
        return {
            tenantId: this.tenantId,
            tenantType: this.tenantType,
            displayName: this.displayName,
            status: this.status,
            features: this.features
        };
    }
}

module.exports = { TenantContext };
