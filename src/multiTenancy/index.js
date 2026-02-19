/**
 * Multi-Tenancy Module Exports
 */
const { TenantContext } = require('./tenantContext');
const { TenantService } = require('./tenantService');
const { TenantDatabaseManager } = require('./tenantDatabaseManager');
const { TenantConfigManager } = require('./tenantConfigManager');
const { TenantValidator } = require('./tenantValidator');
const {
    createTenantMiddleware,
    createOptionalTenantMiddleware,
    TENANT_CONTEXT_KEYS,
    CORRELATION_ID_HEADER,
    TENANT_ID_HEADER
} = require('./tenantMiddleware');

module.exports = {
    TenantContext,
    TenantService,
    TenantDatabaseManager,
    TenantConfigManager,
    TenantValidator,
    createTenantMiddleware,
    createOptionalTenantMiddleware,
    TENANT_CONTEXT_KEYS,
    CORRELATION_ID_HEADER,
    TENANT_ID_HEADER
};
