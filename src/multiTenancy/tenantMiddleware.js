/**
 * TenantMiddleware - Express middleware for tenant context extraction and validation
 *
 * Extracts tenant ID from:
 *   1. JWT claim 'tenant_id' (preferred for B2B)
 *   2. X-Tenant-ID header (API gateway passthrough)
 *   3. URL path prefix /tenants/:tenantId/...
 *
 * Then validates the tenant exists and is active, and stores context in httpContext.
 */
const httpContext = require('express-http-context');
const { logInfo, logError } = require('../operations/common/logging');
const { generateUUID } = require('../utils/uid.util');

/**
 * HTTP context keys for multi-tenancy
 */
const TENANT_CONTEXT_KEYS = {
    TENANT_ID: 'tenantId',
    TENANT_TYPE: 'tenantType',
    TENANT_CONTEXT: 'tenantContext',
    CORRELATION_ID: 'correlationId'
};

const CORRELATION_ID_HEADER = 'x-correlation-id';
const TENANT_ID_HEADER = 'x-tenant-id';

/**
 * Creates tenant extraction middleware
 * @param {Object} params
 * @param {import('./tenantService').TenantService} params.tenantService
 * @param {boolean} [params.required=true] - Whether tenant context is required
 * @returns {Function} Express middleware
 */
function createTenantMiddleware ({ tenantService, required = true }) {
    return async (req, res, next) => {
        try {
            // 1. Extract correlation ID (or generate new one)
            const correlationId = req.headers[CORRELATION_ID_HEADER] || generateUUID();
            httpContext.set(TENANT_CONTEXT_KEYS.CORRELATION_ID, correlationId);
            req.correlationId = correlationId;

            // Set correlation ID on response headers for tracing
            res.setHeader('X-Correlation-ID', correlationId);

            // 2. Extract tenant ID from multiple sources (priority order)
            let tenantId = null;

            // Source 1: JWT claim (most secure for B2B)
            if (req.authInfo && req.authInfo.context && req.authInfo.context.tenant_id) {
                tenantId = req.authInfo.context.tenant_id;
            }

            // Source 2: X-Tenant-ID header (API gateway passthrough)
            if (!tenantId && req.headers[TENANT_ID_HEADER]) {
                tenantId = req.headers[TENANT_ID_HEADER];
            }

            // Source 3: URL path /tenants/:tenantId/...
            if (!tenantId && req.params && req.params.tenantId) {
                tenantId = req.params.tenantId;
            }

            // Source 4: Extract from URL path pattern manually
            if (!tenantId) {
                const tenantMatch = req.path.match(/^\/tenants\/([a-z0-9][a-z0-9-]+[a-z0-9])\//);
                if (tenantMatch) {
                    tenantId = tenantMatch[1];
                }
            }

            // If no tenant ID found and it's required, reject
            if (!tenantId) {
                if (required) {
                    logInfo('Tenant ID not found in request', {
                        path: req.path,
                        method: req.method,
                        correlationId
                    });
                    return res.status(400).json({
                        resourceType: 'OperationOutcome',
                        issue: [{
                            severity: 'error',
                            code: 'required',
                            diagnostics: 'Tenant identification is required. Provide via X-Tenant-ID header, JWT tenant_id claim, or URL path.'
                        }]
                    });
                }
                // Not required, continue without tenant context
                return next();
            }

            // 3. Validate tenant exists and is active
            const tenantContext = await tenantService.getTenantAsync(tenantId);

            if (!tenantContext) {
                logInfo('Tenant not found', { tenantId, correlationId });
                return res.status(404).json({
                    resourceType: 'OperationOutcome',
                    issue: [{
                        severity: 'error',
                        code: 'not-found',
                        diagnostics: `Tenant '${tenantId}' not found`
                    }]
                });
            }

            if (!tenantContext.isActive()) {
                logInfo('Tenant is not active', {
                    tenantId,
                    status: tenantContext.status,
                    correlationId
                });
                return res.status(403).json({
                    resourceType: 'OperationOutcome',
                    issue: [{
                        severity: 'error',
                        code: 'forbidden',
                        diagnostics: `Tenant '${tenantId}' is not active (status: ${tenantContext.status})`
                    }]
                });
            }

            // 4. Store tenant context for downstream use
            httpContext.set(TENANT_CONTEXT_KEYS.TENANT_ID, tenantId);
            httpContext.set(TENANT_CONTEXT_KEYS.TENANT_TYPE, tenantContext.tenantType);
            httpContext.set(TENANT_CONTEXT_KEYS.TENANT_CONTEXT, tenantContext);

            req.tenantId = tenantId;
            req.tenantContext = tenantContext;

            logInfo('Tenant context resolved', {
                tenantId,
                tenantType: tenantContext.tenantType,
                correlationId
            });

            next();
        } catch (err) {
            logError('Error in tenant middleware', { error: err });
            return res.status(500).json({
                resourceType: 'OperationOutcome',
                issue: [{
                    severity: 'error',
                    code: 'exception',
                    diagnostics: 'Internal error resolving tenant context'
                }]
            });
        }
    };
}

/**
 * Creates middleware that makes tenant context optional
 * (for routes that work with or without tenant context)
 * @param {Object} params
 * @param {import('./tenantService').TenantService} params.tenantService
 * @returns {Function} Express middleware
 */
function createOptionalTenantMiddleware ({ tenantService }) {
    return createTenantMiddleware({ tenantService, required: false });
}

module.exports = {
    createTenantMiddleware,
    createOptionalTenantMiddleware,
    TENANT_CONTEXT_KEYS,
    CORRELATION_ID_HEADER,
    TENANT_ID_HEADER
};
