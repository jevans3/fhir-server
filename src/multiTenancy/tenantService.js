/**
 * TenantService - CRUD operations for tenant management
 * Stores tenant records in the platform_config database
 */
const { TenantContext } = require('./tenantContext');
const { TenantValidator } = require('./tenantValidator');
const { logInfo, logError } = require('../operations/common/logging');
const { generateUUID } = require('../utils/uid.util');
const { assertTypeEquals } = require('../utils/assertType');
const { MongoDatabaseManager } = require('../utils/mongoDatabaseManager');

const TENANT_COLLECTION = 'tenants';
const PLATFORM_DB_NAME = process.env.PLATFORM_CONFIG_DB_NAME || 'platform_config';

/**
 * @typedef TenantServiceProps
 * @property {MongoDatabaseManager} mongoDatabaseManager
 */

class TenantService {
    /**
     * @param {TenantServiceProps} params
     */
    constructor ({ mongoDatabaseManager }) {
        /** @type {MongoDatabaseManager} */
        this.mongoDatabaseManager = mongoDatabaseManager;
        assertTypeEquals(mongoDatabaseManager, MongoDatabaseManager);

        /** @type {TenantValidator} */
        this.validator = new TenantValidator();

        /**
         * In-memory tenant cache for fast lookups
         * @type {Map<string, {tenant: Object, cachedAt: number}>}
         */
        this.tenantCache = new Map();

        /** Cache TTL in ms (5 minutes) */
        this.cacheTtlMs = 5 * 60 * 1000;
    }

    /**
     * Get the platform config database
     * @returns {Promise<import('mongodb').Db>}
     */
    async getPlatformDbAsync () {
        const clientDb = await this.mongoDatabaseManager.getClientDbAsync();
        return clientDb.client.db(PLATFORM_DB_NAME);
    }

    /**
     * Get the tenants collection
     * @returns {Promise<import('mongodb').Collection>}
     */
    async getTenantsCollectionAsync () {
        const db = await this.getPlatformDbAsync();
        return db.collection(TENANT_COLLECTION);
    }

    /**
     * Create a new tenant
     * @param {Object} tenantData
     * @returns {Promise<{success: boolean, tenant?: TenantContext, errors?: string[]}>}
     */
    async createTenantAsync (tenantData) {
        const validation = this.validator.validateCreate(tenantData);
        if (!validation.valid) {
            return { success: false, errors: validation.errors };
        }

        try {
            const collection = await this.getTenantsCollectionAsync();

            // Check for existing tenant with same ID
            const existing = await collection.findOne({ tenantId: tenantData.tenantId });
            if (existing) {
                return { success: false, errors: [`Tenant with ID '${tenantData.tenantId}' already exists`] };
            }

            const now = new Date();
            const tenantRecord = {
                _id: generateUUID(),
                tenantId: tenantData.tenantId,
                displayName: tenantData.displayName,
                tenantType: tenantData.tenantType,
                status: 'onboarding',
                organization: tenantData.organization || {},
                database: {
                    name: `fhir_${tenantData.tenantId.replace(/-/g, '_')}`,
                    auditDbName: `audit_${tenantData.tenantId.replace(/-/g, '_')}`,
                    historyDbName: `history_${tenantData.tenantId.replace(/-/g, '_')}`,
                    connectionPoolMin: tenantData.database?.connectionPoolMin || 5,
                    connectionPoolMax: tenantData.database?.connectionPoolMax || 50,
                    ...tenantData.database
                },
                auth: tenantData.auth || {
                    keycloakRealm: tenantData.tenantId,
                    allowedRedirectUris: [],
                    smartConfiguration: {
                        scopesSupported: ['system/*.cruds', 'patient/*.rs', 'user/*.cruds'],
                        tokenEndpointAuthMethods: ['private_key_jwt']
                    },
                    registeredClients: []
                },
                connectedPayers: [],
                connectedProviders: [],
                features: {
                    crdEnabled: false,
                    dtrEnabled: false,
                    pasEnabled: false,
                    cdexEnabled: false,
                    bulkExportEnabled: false,
                    providerAccessApiEnabled: false,
                    payerToPayerEnabled: false,
                    ...tenantData.features
                },
                compliance: {
                    dataRetentionDays: 2555, // 7 years per CMS
                    ...tenantData.compliance
                },
                createdAt: now,
                updatedAt: now,
                createdBy: tenantData.createdBy || 'system'
            };

            await collection.insertOne(tenantRecord);

            logInfo('Tenant created', {
                tenantId: tenantRecord.tenantId,
                tenantType: tenantRecord.tenantType,
                status: tenantRecord.status
            });

            const tenantContext = new TenantContext(tenantRecord);
            this.tenantCache.set(tenantData.tenantId, { tenant: tenantRecord, cachedAt: Date.now() });

            return { success: true, tenant: tenantContext };
        } catch (err) {
            logError('Failed to create tenant', { error: err, tenantId: tenantData.tenantId });
            return { success: false, errors: [err.message] };
        }
    }

    /**
     * Get a tenant by ID (uses cache)
     * @param {string} tenantId
     * @returns {Promise<TenantContext|null>}
     */
    async getTenantAsync (tenantId) {
        // Check cache first
        const cached = this.tenantCache.get(tenantId);
        if (cached && (Date.now() - cached.cachedAt) < this.cacheTtlMs) {
            return new TenantContext(cached.tenant);
        }

        try {
            const collection = await this.getTenantsCollectionAsync();
            const tenantRecord = await collection.findOne({ tenantId });

            if (!tenantRecord) {
                return null;
            }

            // Update cache
            this.tenantCache.set(tenantId, { tenant: tenantRecord, cachedAt: Date.now() });
            return new TenantContext(tenantRecord);
        } catch (err) {
            logError('Failed to get tenant', { error: err, tenantId });
            return null;
        }
    }

    /**
     * List all tenants with optional filtering
     * @param {Object} filter - MongoDB filter
     * @returns {Promise<TenantContext[]>}
     */
    async listTenantsAsync (filter = {}) {
        try {
            const collection = await this.getTenantsCollectionAsync();
            const tenants = await collection.find(filter).toArray();
            return tenants.map(t => new TenantContext(t));
        } catch (err) {
            logError('Failed to list tenants', { error: err });
            return [];
        }
    }

    /**
     * Update a tenant
     * @param {string} tenantId
     * @param {Object} updateData
     * @returns {Promise<{success: boolean, tenant?: TenantContext, errors?: string[]}>}
     */
    async updateTenantAsync (tenantId, updateData) {
        const validation = this.validator.validateUpdate(updateData);
        if (!validation.valid) {
            return { success: false, errors: validation.errors };
        }

        try {
            const collection = await this.getTenantsCollectionAsync();

            updateData.updatedAt = new Date();

            const result = await collection.findOneAndUpdate(
                { tenantId },
                { $set: updateData },
                { returnDocument: 'after' }
            );

            if (!result) {
                return { success: false, errors: [`Tenant '${tenantId}' not found`] };
            }

            // Invalidate cache
            this.tenantCache.delete(tenantId);

            logInfo('Tenant updated', { tenantId, updatedFields: Object.keys(updateData) });
            return { success: true, tenant: new TenantContext(result) };
        } catch (err) {
            logError('Failed to update tenant', { error: err, tenantId });
            return { success: false, errors: [err.message] };
        }
    }

    /**
     * Activate a tenant
     * @param {string} tenantId
     * @returns {Promise<{success: boolean, errors?: string[]}>}
     */
    async activateTenantAsync (tenantId) {
        return this.updateTenantAsync(tenantId, { status: 'active' });
    }

    /**
     * Suspend a tenant
     * @param {string} tenantId
     * @returns {Promise<{success: boolean, errors?: string[]}>}
     */
    async suspendTenantAsync (tenantId) {
        return this.updateTenantAsync(tenantId, { status: 'suspended' });
    }

    /**
     * Add a payer connection to a provider tenant
     * @param {string} tenantId
     * @param {Object} connectionData
     * @returns {Promise<{success: boolean, errors?: string[]}>}
     */
    async addPayerConnectionAsync (tenantId, connectionData) {
        const validation = this.validator.validatePayerConnection(connectionData);
        if (!validation.valid) {
            return { success: false, errors: validation.errors };
        }

        try {
            const collection = await this.getTenantsCollectionAsync();
            connectionData.status = connectionData.status || 'pending_verification';

            const result = await collection.updateOne(
                { tenantId, tenantType: 'provider' },
                {
                    $push: { connectedPayers: connectionData },
                    $set: { updatedAt: new Date() }
                }
            );

            if (result.matchedCount === 0) {
                return { success: false, errors: [`Provider tenant '${tenantId}' not found`] };
            }

            this.tenantCache.delete(tenantId);
            logInfo('Payer connection added', { tenantId, payerTenantId: connectionData.payerTenantId });
            return { success: true };
        } catch (err) {
            logError('Failed to add payer connection', { error: err, tenantId });
            return { success: false, errors: [err.message] };
        }
    }

    /**
     * Register a SMART client for a tenant
     * @param {string} tenantId
     * @param {Object} clientData
     * @returns {Promise<{success: boolean, clientId?: string, errors?: string[]}>}
     */
    async registerClientAsync (tenantId, clientData) {
        try {
            const collection = await this.getTenantsCollectionAsync();
            const clientId = clientData.clientId || `${tenantId}-${generateUUID().substring(0, 8)}`;

            const clientRecord = {
                clientId,
                clientType: clientData.clientType || 'backend_service',
                publicKeyFingerprint: clientData.publicKeyFingerprint,
                grantedScopes: clientData.grantedScopes || [],
                status: 'active',
                createdAt: new Date()
            };

            const result = await collection.updateOne(
                { tenantId },
                {
                    $push: { 'auth.registeredClients': clientRecord },
                    $set: { updatedAt: new Date() }
                }
            );

            if (result.matchedCount === 0) {
                return { success: false, errors: [`Tenant '${tenantId}' not found`] };
            }

            this.tenantCache.delete(tenantId);
            logInfo('SMART client registered', { tenantId, clientId });
            return { success: true, clientId };
        } catch (err) {
            logError('Failed to register client', { error: err, tenantId });
            return { success: false, errors: [err.message] };
        }
    }

    /**
     * Clear the in-memory tenant cache
     */
    clearCache () {
        this.tenantCache.clear();
    }
}

module.exports = { TenantService };
