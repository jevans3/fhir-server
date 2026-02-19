/**
 * TenantAdminRouter - Express router for tenant administration and onboarding APIs
 *
 * Provides RESTful endpoints for managing tenants in the multi-tenant FHIR
 * prior authorization platform. All routes are prefixed with /admin/api/v1
 * and require admin-level JWT authentication.
 *
 * Endpoints:
 *   POST   /tenants                              - Create new tenant
 *   GET    /tenants                              - List all tenants
 *   GET    /tenants/:tenantId                    - Get tenant details
 *   PUT    /tenants/:tenantId                    - Update tenant config
 *   POST   /tenants/:tenantId/activate           - Activate tenant
 *   POST   /tenants/:tenantId/suspend            - Suspend tenant
 *   POST   /tenants/:tenantId/clients            - Register SMART client
 *   DELETE /tenants/:tenantId/clients/:clientId   - Revoke client
 *   POST   /tenants/:tenantId/payer-connections  - Connect to payer
 *   DELETE /tenants/:tenantId/payer-connections/:payerId - Disconnect payer
 *   GET    /tenants/:tenantId/health             - Tenant health check
 */

const express = require('express');
const { logInfo, logError } = require('../operations/common/logging');
const { TenantService } = require('../multiTenancy/tenantService');
const { TenantDatabaseManager } = require('../multiTenancy/tenantDatabaseManager');
const { assertTypeEquals } = require('../utils/assertType');
const { generateUUID } = require('../utils/uid.util');

/**
 * Creates a FHIR OperationOutcome resource for error responses
 * @param {string} severity - 'error' | 'warning' | 'information' | 'fatal'
 * @param {string} code - Issue type code (e.g., 'not-found', 'invalid', 'security', 'processing')
 * @param {string} diagnostics - Human-readable diagnostic message
 * @param {number} httpStatus - HTTP status code
 * @returns {{statusCode: number, body: Object}}
 */
function createOperationOutcome (severity, code, diagnostics, httpStatus) {
    return {
        statusCode: httpStatus,
        body: {
            resourceType: 'OperationOutcome',
            id: generateUUID(),
            issue: [
                {
                    severity,
                    code,
                    diagnostics
                }
            ]
        }
    };
}

/**
 * Creates a success OperationOutcome
 * @param {string} diagnostics - Success message
 * @returns {Object} FHIR OperationOutcome resource
 */
function createSuccessOutcome (diagnostics) {
    return {
        resourceType: 'OperationOutcome',
        id: generateUUID(),
        issue: [
            {
                severity: 'information',
                code: 'informational',
                diagnostics
            }
        ]
    };
}

/**
 * Admin JWT authentication middleware.
 * Verifies the bearer token has the 'admin' scope or role.
 * This is a simplified implementation; in production, it should integrate
 * with the platform's Passport JWT strategy for full validation.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function adminAuthMiddleware (req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        const outcome = createOperationOutcome(
            'error',
            'security',
            'Missing or invalid Authorization header. A valid admin Bearer token is required.',
            401
        );
        return res.status(outcome.statusCode).json(outcome.body);
    }

    // In a full implementation, this would verify the JWT using the platform's
    // Passport strategy and check for admin scopes. For now, we extract the
    // token and attach a placeholder admin context.
    const token = authHeader.substring(7);
    if (!token) {
        const outcome = createOperationOutcome(
            'error',
            'security',
            'Empty bearer token provided.',
            401
        );
        return res.status(outcome.statusCode).json(outcome.body);
    }

    // Attach admin context to request for downstream handlers
    req.adminContext = {
        token,
        authenticatedAt: new Date().toISOString(),
        // In production, these values come from JWT claims
        adminId: req.headers['x-admin-id'] || 'system',
        adminScopes: req.headers['x-admin-scopes'] || 'admin/*'
    };

    next();
}

class TenantAdminRouter {
    /**
     * Constructor
     * @typedef {Object} TenantAdminRouterParams
     * @property {TenantService} tenantService
     * @property {TenantDatabaseManager} tenantDatabaseManager
     *
     * @param {TenantAdminRouterParams} params
     */
    constructor ({ tenantService, tenantDatabaseManager }) {
        assertTypeEquals(tenantService, TenantService);
        assertTypeEquals(tenantDatabaseManager, TenantDatabaseManager);

        /**
         * @type {TenantService}
         */
        this.tenantService = tenantService;

        /**
         * @type {TenantDatabaseManager}
         */
        this.tenantDatabaseManager = tenantDatabaseManager;

        /**
         * @type {import('express').Router}
         */
        this.router = express.Router();

        this._initializeRoutes();
    }

    /**
     * Get the configured Express router
     * @returns {import('express').Router}
     */
    getRouter () {
        return this.router;
    }

    /**
     * Initialize all admin API routes
     * @private
     */
    _initializeRoutes () {
        // Apply admin authentication to all routes
        this.router.use(adminAuthMiddleware);

        // JSON body parsing
        this.router.use(express.json({ limit: '1mb' }));

        // Tenant CRUD
        this.router.post('/tenants', this._createTenant.bind(this));
        this.router.get('/tenants', this._listTenants.bind(this));
        this.router.get('/tenants/:tenantId', this._getTenant.bind(this));
        this.router.put('/tenants/:tenantId', this._updateTenant.bind(this));

        // Tenant lifecycle
        this.router.post('/tenants/:tenantId/activate', this._activateTenant.bind(this));
        this.router.post('/tenants/:tenantId/suspend', this._suspendTenant.bind(this));

        // SMART client management
        this.router.post('/tenants/:tenantId/clients', this._registerClient.bind(this));
        this.router.delete('/tenants/:tenantId/clients/:clientId', this._revokeClient.bind(this));

        // Payer connections
        this.router.post('/tenants/:tenantId/payer-connections', this._connectPayer.bind(this));
        this.router.delete('/tenants/:tenantId/payer-connections/:payerId', this._disconnectPayer.bind(this));

        // Health check
        this.router.get('/tenants/:tenantId/health', this._tenantHealthCheck.bind(this));
    }

    /**
     * POST /tenants - Create a new tenant
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @private
     */
    async _createTenant (req, res) {
        try {
            const tenantData = req.body;

            if (!tenantData || !tenantData.tenantId || !tenantData.displayName) {
                const outcome = createOperationOutcome(
                    'error',
                    'invalid',
                    'Request body must include tenantId and displayName.',
                    400
                );
                return res.status(outcome.statusCode).json(outcome.body);
            }

            tenantData.createdBy = req.adminContext.adminId;

            const result = await this.tenantService.createTenantAsync(tenantData);

            if (!result.success) {
                const outcome = createOperationOutcome(
                    'error',
                    'processing',
                    `Failed to create tenant: ${result.errors.join('; ')}`,
                    422
                );
                return res.status(outcome.statusCode).json(outcome.body);
            }

            logInfo('Tenant created via admin API', {
                tenantId: tenantData.tenantId,
                createdBy: req.adminContext.adminId
            });

            return res.status(201).json({
                resourceType: 'OperationOutcome',
                id: generateUUID(),
                issue: [{
                    severity: 'information',
                    code: 'informational',
                    diagnostics: `Tenant '${tenantData.tenantId}' created successfully.`
                }],
                tenant: result.tenant
            });
        } catch (err) {
            logError('Error creating tenant', { error: err });
            const outcome = createOperationOutcome(
                'error',
                'exception',
                `Internal error creating tenant: ${err.message}`,
                500
            );
            return res.status(outcome.statusCode).json(outcome.body);
        }
    }

    /**
     * GET /tenants - List all tenants
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @private
     */
    async _listTenants (req, res) {
        try {
            const filter = {};
            if (req.query.status) {
                filter.status = req.query.status;
            }
            if (req.query.tenantType) {
                filter.tenantType = req.query.tenantType;
            }

            const tenants = await this.tenantService.listTenantsAsync(filter);

            return res.status(200).json({
                total: tenants.length,
                tenants
            });
        } catch (err) {
            logError('Error listing tenants', { error: err });
            const outcome = createOperationOutcome(
                'error',
                'exception',
                `Internal error listing tenants: ${err.message}`,
                500
            );
            return res.status(outcome.statusCode).json(outcome.body);
        }
    }

    /**
     * GET /tenants/:tenantId - Get tenant details
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @private
     */
    async _getTenant (req, res) {
        try {
            const { tenantId } = req.params;
            const tenant = await this.tenantService.getTenantAsync(tenantId);

            if (!tenant) {
                const outcome = createOperationOutcome(
                    'error',
                    'not-found',
                    `Tenant '${tenantId}' not found.`,
                    404
                );
                return res.status(outcome.statusCode).json(outcome.body);
            }

            return res.status(200).json(tenant);
        } catch (err) {
            logError('Error getting tenant', { error: err, tenantId: req.params.tenantId });
            const outcome = createOperationOutcome(
                'error',
                'exception',
                `Internal error getting tenant: ${err.message}`,
                500
            );
            return res.status(outcome.statusCode).json(outcome.body);
        }
    }

    /**
     * PUT /tenants/:tenantId - Update tenant configuration
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @private
     */
    async _updateTenant (req, res) {
        try {
            const { tenantId } = req.params;
            const updateData = req.body;

            if (!updateData || Object.keys(updateData).length === 0) {
                const outcome = createOperationOutcome(
                    'error',
                    'invalid',
                    'Request body must contain fields to update.',
                    400
                );
                return res.status(outcome.statusCode).json(outcome.body);
            }

            // Prevent updating immutable fields
            delete updateData.tenantId;
            delete updateData._id;
            delete updateData.createdAt;
            delete updateData.createdBy;

            updateData.updatedBy = req.adminContext.adminId;

            const result = await this.tenantService.updateTenantAsync(tenantId, updateData);

            if (!result.success) {
                const statusCode = result.errors.some(e => e.includes('not found')) ? 404 : 422;
                const outcome = createOperationOutcome(
                    'error',
                    statusCode === 404 ? 'not-found' : 'processing',
                    `Failed to update tenant: ${result.errors.join('; ')}`,
                    statusCode
                );
                return res.status(outcome.statusCode).json(outcome.body);
            }

            logInfo('Tenant updated via admin API', {
                tenantId,
                updatedBy: req.adminContext.adminId,
                fields: Object.keys(updateData)
            });

            return res.status(200).json({
                ...createSuccessOutcome(`Tenant '${tenantId}' updated successfully.`),
                tenant: result.tenant
            });
        } catch (err) {
            logError('Error updating tenant', { error: err, tenantId: req.params.tenantId });
            const outcome = createOperationOutcome(
                'error',
                'exception',
                `Internal error updating tenant: ${err.message}`,
                500
            );
            return res.status(outcome.statusCode).json(outcome.body);
        }
    }

    /**
     * POST /tenants/:tenantId/activate - Activate a tenant
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @private
     */
    async _activateTenant (req, res) {
        try {
            const { tenantId } = req.params;

            // Verify tenant exists before activation
            const tenant = await this.tenantService.getTenantAsync(tenantId);
            if (!tenant) {
                const outcome = createOperationOutcome(
                    'error',
                    'not-found',
                    `Tenant '${tenantId}' not found.`,
                    404
                );
                return res.status(outcome.statusCode).json(outcome.body);
            }

            const result = await this.tenantService.activateTenantAsync(tenantId);

            if (!result.success) {
                const outcome = createOperationOutcome(
                    'error',
                    'processing',
                    `Failed to activate tenant: ${result.errors.join('; ')}`,
                    422
                );
                return res.status(outcome.statusCode).json(outcome.body);
            }

            logInfo('Tenant activated via admin API', {
                tenantId,
                activatedBy: req.adminContext.adminId
            });

            return res.status(200).json(
                createSuccessOutcome(`Tenant '${tenantId}' activated successfully.`)
            );
        } catch (err) {
            logError('Error activating tenant', { error: err, tenantId: req.params.tenantId });
            const outcome = createOperationOutcome(
                'error',
                'exception',
                `Internal error activating tenant: ${err.message}`,
                500
            );
            return res.status(outcome.statusCode).json(outcome.body);
        }
    }

    /**
     * POST /tenants/:tenantId/suspend - Suspend a tenant
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @private
     */
    async _suspendTenant (req, res) {
        try {
            const { tenantId } = req.params;

            const tenant = await this.tenantService.getTenantAsync(tenantId);
            if (!tenant) {
                const outcome = createOperationOutcome(
                    'error',
                    'not-found',
                    `Tenant '${tenantId}' not found.`,
                    404
                );
                return res.status(outcome.statusCode).json(outcome.body);
            }

            const result = await this.tenantService.suspendTenantAsync(tenantId);

            if (!result.success) {
                const outcome = createOperationOutcome(
                    'error',
                    'processing',
                    `Failed to suspend tenant: ${result.errors.join('; ')}`,
                    422
                );
                return res.status(outcome.statusCode).json(outcome.body);
            }

            logInfo('Tenant suspended via admin API', {
                tenantId,
                suspendedBy: req.adminContext.adminId
            });

            return res.status(200).json(
                createSuccessOutcome(`Tenant '${tenantId}' suspended successfully.`)
            );
        } catch (err) {
            logError('Error suspending tenant', { error: err, tenantId: req.params.tenantId });
            const outcome = createOperationOutcome(
                'error',
                'exception',
                `Internal error suspending tenant: ${err.message}`,
                500
            );
            return res.status(outcome.statusCode).json(outcome.body);
        }
    }

    /**
     * POST /tenants/:tenantId/clients - Register a SMART client for the tenant
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @private
     */
    async _registerClient (req, res) {
        try {
            const { tenantId } = req.params;
            const clientData = req.body;

            if (!clientData) {
                const outcome = createOperationOutcome(
                    'error',
                    'invalid',
                    'Request body must contain client registration data.',
                    400
                );
                return res.status(outcome.statusCode).json(outcome.body);
            }

            const result = await this.tenantService.registerClientAsync(tenantId, clientData);

            if (!result.success) {
                const statusCode = result.errors.some(e => e.includes('not found')) ? 404 : 422;
                const outcome = createOperationOutcome(
                    'error',
                    statusCode === 404 ? 'not-found' : 'processing',
                    `Failed to register client: ${result.errors.join('; ')}`,
                    statusCode
                );
                return res.status(outcome.statusCode).json(outcome.body);
            }

            logInfo('SMART client registered via admin API', {
                tenantId,
                clientId: result.clientId,
                registeredBy: req.adminContext.adminId
            });

            return res.status(201).json({
                ...createSuccessOutcome(`Client '${result.clientId}' registered for tenant '${tenantId}'.`),
                clientId: result.clientId
            });
        } catch (err) {
            logError('Error registering client', { error: err, tenantId: req.params.tenantId });
            const outcome = createOperationOutcome(
                'error',
                'exception',
                `Internal error registering client: ${err.message}`,
                500
            );
            return res.status(outcome.statusCode).json(outcome.body);
        }
    }

    /**
     * DELETE /tenants/:tenantId/clients/:clientId - Revoke a SMART client
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @private
     */
    async _revokeClient (req, res) {
        try {
            const { tenantId, clientId } = req.params;

            // Use the update mechanism to remove the client from the registered clients array
            const result = await this.tenantService.updateTenantAsync(tenantId, {
                $pull: { 'auth.registeredClients': { clientId } }
            });

            if (!result.success) {
                const statusCode = result.errors.some(e => e.includes('not found')) ? 404 : 422;
                const outcome = createOperationOutcome(
                    'error',
                    statusCode === 404 ? 'not-found' : 'processing',
                    `Failed to revoke client: ${result.errors.join('; ')}`,
                    statusCode
                );
                return res.status(outcome.statusCode).json(outcome.body);
            }

            logInfo('SMART client revoked via admin API', {
                tenantId,
                clientId,
                revokedBy: req.adminContext.adminId
            });

            return res.status(200).json(
                createSuccessOutcome(`Client '${clientId}' revoked from tenant '${tenantId}'.`)
            );
        } catch (err) {
            logError('Error revoking client', {
                error: err,
                tenantId: req.params.tenantId,
                clientId: req.params.clientId
            });
            const outcome = createOperationOutcome(
                'error',
                'exception',
                `Internal error revoking client: ${err.message}`,
                500
            );
            return res.status(outcome.statusCode).json(outcome.body);
        }
    }

    /**
     * POST /tenants/:tenantId/payer-connections - Connect tenant to a payer
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @private
     */
    async _connectPayer (req, res) {
        try {
            const { tenantId } = req.params;
            const connectionData = req.body;

            if (!connectionData || !connectionData.payerTenantId) {
                const outcome = createOperationOutcome(
                    'error',
                    'invalid',
                    'Request body must include payerTenantId.',
                    400
                );
                return res.status(outcome.statusCode).json(outcome.body);
            }

            const result = await this.tenantService.addPayerConnectionAsync(tenantId, connectionData);

            if (!result.success) {
                const statusCode = result.errors.some(e => e.includes('not found')) ? 404 : 422;
                const outcome = createOperationOutcome(
                    'error',
                    statusCode === 404 ? 'not-found' : 'processing',
                    `Failed to connect payer: ${result.errors.join('; ')}`,
                    statusCode
                );
                return res.status(outcome.statusCode).json(outcome.body);
            }

            logInfo('Payer connection created via admin API', {
                tenantId,
                payerTenantId: connectionData.payerTenantId,
                connectedBy: req.adminContext.adminId
            });

            return res.status(201).json(
                createSuccessOutcome(`Payer '${connectionData.payerTenantId}' connected to tenant '${tenantId}'.`)
            );
        } catch (err) {
            logError('Error connecting payer', { error: err, tenantId: req.params.tenantId });
            const outcome = createOperationOutcome(
                'error',
                'exception',
                `Internal error connecting payer: ${err.message}`,
                500
            );
            return res.status(outcome.statusCode).json(outcome.body);
        }
    }

    /**
     * DELETE /tenants/:tenantId/payer-connections/:payerId - Disconnect a payer
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @private
     */
    async _disconnectPayer (req, res) {
        try {
            const { tenantId, payerId } = req.params;

            const result = await this.tenantService.updateTenantAsync(tenantId, {
                $pull: { connectedPayers: { payerTenantId: payerId } }
            });

            if (!result.success) {
                const statusCode = result.errors.some(e => e.includes('not found')) ? 404 : 422;
                const outcome = createOperationOutcome(
                    'error',
                    statusCode === 404 ? 'not-found' : 'processing',
                    `Failed to disconnect payer: ${result.errors.join('; ')}`,
                    statusCode
                );
                return res.status(outcome.statusCode).json(outcome.body);
            }

            logInfo('Payer disconnected via admin API', {
                tenantId,
                payerTenantId: payerId,
                disconnectedBy: req.adminContext.adminId
            });

            return res.status(200).json(
                createSuccessOutcome(`Payer '${payerId}' disconnected from tenant '${tenantId}'.`)
            );
        } catch (err) {
            logError('Error disconnecting payer', {
                error: err,
                tenantId: req.params.tenantId,
                payerId: req.params.payerId
            });
            const outcome = createOperationOutcome(
                'error',
                'exception',
                `Internal error disconnecting payer: ${err.message}`,
                500
            );
            return res.status(outcome.statusCode).json(outcome.body);
        }
    }

    /**
     * GET /tenants/:tenantId/health - Check tenant database health
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @private
     */
    async _tenantHealthCheck (req, res) {
        try {
            const { tenantId } = req.params;

            // Verify tenant exists
            const tenant = await this.tenantService.getTenantAsync(tenantId);
            if (!tenant) {
                const outcome = createOperationOutcome(
                    'error',
                    'not-found',
                    `Tenant '${tenantId}' not found.`,
                    404
                );
                return res.status(outcome.statusCode).json(outcome.body);
            }

            // Check database connectivity
            const dbHealthy = await this.tenantDatabaseManager.healthCheckAsync(tenantId);

            const healthStatus = {
                tenantId,
                status: dbHealthy ? 'healthy' : 'degraded',
                checks: {
                    database: {
                        status: dbHealthy ? 'up' : 'down',
                        checkedAt: new Date().toISOString()
                    },
                    tenantRecord: {
                        status: 'up',
                        tenantStatus: tenant.status || tenant.tenantId,
                        checkedAt: new Date().toISOString()
                    }
                },
                timestamp: new Date().toISOString()
            };

            const httpStatus = dbHealthy ? 200 : 503;
            return res.status(httpStatus).json(healthStatus);
        } catch (err) {
            logError('Error checking tenant health', { error: err, tenantId: req.params.tenantId });
            return res.status(503).json({
                tenantId: req.params.tenantId,
                status: 'error',
                checks: {
                    database: {
                        status: 'error',
                        error: err.message,
                        checkedAt: new Date().toISOString()
                    }
                },
                timestamp: new Date().toISOString()
            });
        }
    }
}

module.exports = {
    TenantAdminRouter,
    createOperationOutcome,
    createSuccessOutcome,
    adminAuthMiddleware
};
