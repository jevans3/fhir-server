/**
 * TenantConfigManager - Per-tenant configuration resolution
 *
 * Resolves configuration values with tenant-specific overrides.
 * Falls back to platform-level defaults from ConfigManager.
 */
const { ConfigManager } = require('../utils/configManager');
const { assertTypeEquals } = require('../utils/assertType');

/**
 * @typedef TenantConfigManagerProps
 * @property {ConfigManager} configManager
 */

class TenantConfigManager {
    /**
     * @param {TenantConfigManagerProps} params
     */
    constructor ({ configManager }) {
        /** @type {ConfigManager} */
        this.configManager = configManager;
        assertTypeEquals(configManager, ConfigManager);
    }

    /**
     * Check if multi-tenancy is enabled
     * @returns {boolean}
     */
    get multiTenancyEnabled () {
        return process.env.ENABLE_MULTI_TENANCY === '1' ||
               process.env.ENABLE_MULTI_TENANCY === 'true';
    }

    /**
     * Get the platform config database name
     * @returns {string}
     */
    get platformConfigDbName () {
        return process.env.PLATFORM_CONFIG_DB_NAME || 'platform_config';
    }

    /**
     * Get the tenant cache TTL in milliseconds
     * @returns {number}
     */
    get tenantCacheTtlMs () {
        return process.env.TENANT_CACHE_TTL_MS
            ? parseInt(process.env.TENANT_CACHE_TTL_MS)
            : 5 * 60 * 1000; // 5 minutes
    }

    /**
     * Get the max idle time for tenant DB connections in milliseconds
     * @returns {number}
     */
    get tenantDbMaxIdleTimeMs () {
        return process.env.TENANT_DB_MAX_IDLE_MS
            ? parseInt(process.env.TENANT_DB_MAX_IDLE_MS)
            : 30 * 60 * 1000; // 30 minutes
    }

    /**
     * Whether to require tenant context for FHIR operations
     * @returns {boolean}
     */
    get requireTenantContext () {
        return this.multiTenancyEnabled;
    }

    /**
     * Whether CRD (Coverage Requirements Discovery) is enabled platform-wide
     * @returns {boolean}
     */
    get crdEnabled () {
        return process.env.ENABLE_CRD === '1' || process.env.ENABLE_CRD === 'true';
    }

    /**
     * Whether DTR (Documentation, Templates, and Rules) is enabled platform-wide
     * @returns {boolean}
     */
    get dtrEnabled () {
        return process.env.ENABLE_DTR === '1' || process.env.ENABLE_DTR === 'true';
    }

    /**
     * Whether PAS (Prior Authorization Support) is enabled platform-wide
     * @returns {boolean}
     */
    get pasEnabled () {
        return process.env.ENABLE_PAS === '1' || process.env.ENABLE_PAS === 'true';
    }

    /**
     * Whether CDex (Clinical Data Exchange) is enabled platform-wide
     * @returns {boolean}
     */
    get cdexEnabled () {
        return process.env.ENABLE_CDEX === '1' || process.env.ENABLE_CDEX === 'true';
    }

    /**
     * Whether X12 translation is enabled
     * @returns {boolean}
     */
    get x12TranslationEnabled () {
        return process.env.ENABLE_X12_TRANSLATION === '1' ||
               process.env.ENABLE_X12_TRANSLATION === 'true';
    }

    /**
     * PAS response timeout in milliseconds (default: 15 seconds per PAS IG)
     * @returns {number}
     */
    get pasResponseTimeoutMs () {
        return process.env.PAS_RESPONSE_TIMEOUT_MS
            ? parseInt(process.env.PAS_RESPONSE_TIMEOUT_MS)
            : 15000;
    }

    /**
     * Default data retention period in days (7 years per CMS)
     * @returns {number}
     */
    get defaultDataRetentionDays () {
        return process.env.DEFAULT_DATA_RETENTION_DAYS
            ? parseInt(process.env.DEFAULT_DATA_RETENTION_DAYS)
            : 2555; // 7 years
    }

    /**
     * Whether enhanced audit logging (CMS-compliant) is enabled
     * @returns {boolean}
     */
    get enhancedAuditEnabled () {
        return process.env.ENABLE_ENHANCED_AUDIT === '1' ||
               process.env.ENABLE_ENHANCED_AUDIT === 'true';
    }

    /**
     * Whether correlation ID tracing is enabled
     * @returns {boolean}
     */
    get correlationTracingEnabled () {
        return process.env.ENABLE_CORRELATION_TRACING !== '0'; // enabled by default
    }

    /**
     * Resolve a configuration value with tenant override support
     * @param {string} key - Configuration key
     * @param {Object} [tenantContext] - Tenant context for overrides
     * @param {*} [defaultValue] - Default value if not found
     * @returns {*}
     */
    resolve (key, tenantContext = null, defaultValue = undefined) {
        // Check tenant-specific override first
        if (tenantContext && tenantContext.features && tenantContext.features[key] !== undefined) {
            return tenantContext.features[key];
        }

        // Fall back to platform config
        if (this.configManager[key] !== undefined) {
            return this.configManager[key];
        }

        return defaultValue;
    }
}

module.exports = { TenantConfigManager };
