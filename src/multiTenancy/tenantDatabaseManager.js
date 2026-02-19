/**
 * TenantDatabaseManager - Manages per-tenant MongoDB connections
 *
 * Extends the base MongoDatabaseManager pattern to resolve databases
 * based on the current tenant context. Each tenant gets isolated
 * databases for FHIR data, audit events, and history.
 */
const { MongoClient, GridFSBucket } = require('mongodb');
const { mongoConfig } = require('../config');
const { logInfo, logError } = require('../operations/common/logging');
const { logSystemEventAsync } = require('../operations/common/systemEventLogging');
const { isTrue } = require('../utils/isTrue');
const { ConfigManager } = require('../utils/configManager');
const { assertTypeEquals } = require('../utils/assertType');

/**
 * @typedef TenantDatabaseManagerProps
 * @property {ConfigManager} configManager
 */

class TenantDatabaseManager {
    /**
     * @param {TenantDatabaseManagerProps} params
     */
    constructor ({ configManager }) {
        /** @type {ConfigManager} */
        this.configManager = configManager;
        assertTypeEquals(configManager, ConfigManager);

        /**
         * Connection pool cache: tenantId -> { client, dbs, lastAccessed }
         * @type {Map<string, {client: import('mongodb').MongoClient, dbs: Object, lastAccessed: number}>}
         */
        this.connectionPool = new Map();

        /**
         * Platform connection (for tenant config storage)
         * @type {import('mongodb').MongoClient|null}
         */
        this.platformClient = null;

        /**
         * Max idle time before closing a tenant connection (30 minutes)
         * @type {number}
         */
        this.maxIdleTimeMs = 30 * 60 * 1000;

        /**
         * GridFS bucket cache per tenant
         * @type {Map<string, import('mongodb').GridFSBucket>}
         */
        this.gridFsBuckets = new Map();
    }

    /**
     * Get or create the platform MongoDB client
     * @returns {Promise<import('mongodb').MongoClient>}
     */
    async getPlatformClientAsync () {
        if (!this.platformClient) {
            const connectionUrl = mongoConfig.connection;
            this.platformClient = new MongoClient(connectionUrl, mongoConfig.options);
            await this.platformClient.connect();
            await this.platformClient.db('admin').command({ ping: 1 });
            logInfo('Platform MongoDB client connected');
        }
        return this.platformClient;
    }

    /**
     * Get or create a MongoDB client for a specific tenant
     * @param {string} tenantId
     * @param {Object} [tenantDbConfig] - Tenant-specific database configuration
     * @returns {Promise<import('mongodb').MongoClient>}
     */
    async getClientForTenantAsync (tenantId, tenantDbConfig = {}) {
        const cached = this.connectionPool.get(tenantId);
        if (cached) {
            cached.lastAccessed = Date.now();
            return cached.client;
        }

        // Create new connection for this tenant
        // Use the same MongoDB cluster but different databases
        const connectionUrl = tenantDbConfig.connectionUrl || mongoConfig.connection;
        const options = {
            ...mongoConfig.options,
            minPoolSize: tenantDbConfig.connectionPoolMin || 5,
            maxPoolSize: tenantDbConfig.connectionPoolMax || 50,
            appName: `fhir-server-tenant-${tenantId}`
        };

        const client = new MongoClient(connectionUrl, options);

        try {
            await client.connect();
            await client.db('admin').command({ ping: 1 });

            await logSystemEventAsync({
                event: 'tenantDbConnect',
                message: `Connected to database for tenant ${tenantId}`,
                args: { tenantId }
            });

            if (isTrue(process.env.LOG_ALL_MONGO_CALLS)) {
                client.on('commandStarted', event => {
                    logInfo('Tenant MongoDB commandStarted', { tenantId, event });
                });
            }

            this.connectionPool.set(tenantId, {
                client,
                dbs: {},
                lastAccessed: Date.now()
            });

            return client;
        } catch (err) {
            logError(`Failed to connect to database for tenant ${tenantId}`, { error: err });
            throw err;
        }
    }

    /**
     * Get the FHIR database for a specific tenant
     * @param {string} tenantId
     * @param {Object} [tenantContext] - Tenant context with database config
     * @returns {Promise<import('mongodb').Db>}
     */
    async getFhirDbForTenantAsync (tenantId, tenantContext = null) {
        const dbName = tenantContext
            ? tenantContext.getFhirDbName()
            : `fhir_${tenantId.replace(/-/g, '_')}`;

        return this.getDbForTenantAsync(tenantId, dbName, 'fhir', tenantContext?.database);
    }

    /**
     * Get the audit database for a specific tenant
     * @param {string} tenantId
     * @param {Object} [tenantContext] - Tenant context with database config
     * @returns {Promise<import('mongodb').Db>}
     */
    async getAuditDbForTenantAsync (tenantId, tenantContext = null) {
        const dbName = tenantContext
            ? tenantContext.getAuditDbName()
            : `audit_${tenantId.replace(/-/g, '_')}`;

        return this.getDbForTenantAsync(tenantId, dbName, 'audit', tenantContext?.database);
    }

    /**
     * Get the history database for a specific tenant
     * @param {string} tenantId
     * @param {Object} [tenantContext] - Tenant context with database config
     * @returns {Promise<import('mongodb').Db>}
     */
    async getHistoryDbForTenantAsync (tenantId, tenantContext = null) {
        const dbName = tenantContext
            ? tenantContext.getHistoryDbName()
            : `history_${tenantId.replace(/-/g, '_')}`;

        return this.getDbForTenantAsync(tenantId, dbName, 'history', tenantContext?.database);
    }

    /**
     * Get a specific database for a tenant (with caching)
     * @param {string} tenantId
     * @param {string} dbName
     * @param {string} dbType - 'fhir' | 'audit' | 'history'
     * @param {Object} [dbConfig]
     * @returns {Promise<import('mongodb').Db>}
     */
    async getDbForTenantAsync (tenantId, dbName, dbType, dbConfig = {}) {
        const cached = this.connectionPool.get(tenantId);
        if (cached && cached.dbs[dbType]) {
            cached.lastAccessed = Date.now();
            return cached.dbs[dbType];
        }

        const client = await this.getClientForTenantAsync(tenantId, dbConfig);
        const db = client.db(dbName);

        // Cache the db reference
        const entry = this.connectionPool.get(tenantId);
        if (entry) {
            entry.dbs[dbType] = db;
        }

        return db;
    }

    /**
     * Get the appropriate database for a resource type within a tenant
     * @param {string} tenantId
     * @param {string} resourceType
     * @param {Object} extraInfo
     * @param {Object} [tenantContext]
     * @returns {Promise<import('mongodb').Db>}
     */
    async getDatabaseForTenantResourceAsync ({ tenantId, resourceType, extraInfo = {}, tenantContext = null }) {
        const searchOperationNames = ['search', 'searchStreaming', 'searchById'];

        if (resourceType === 'AuditEvent') {
            return await this.getAuditDbForTenantAsync(tenantId, tenantContext);
        } else if (extraInfo.isHistoryQuery || resourceType?.endsWith('_History')) {
            return await this.getHistoryDbForTenantAsync(tenantId, tenantContext);
        }
        return await this.getFhirDbForTenantAsync(tenantId, tenantContext);
    }

    /**
     * Get a GridFS bucket for a tenant
     * @param {string} tenantId
     * @param {Object} [tenantContext]
     * @returns {Promise<import('mongodb').GridFSBucket>}
     */
    async getGridFsBucketForTenantAsync (tenantId, tenantContext = null) {
        if (!this.gridFsBuckets.has(tenantId)) {
            const db = await this.getFhirDbForTenantAsync(tenantId, tenantContext);
            this.gridFsBuckets.set(tenantId, new GridFSBucket(db));
        }
        return this.gridFsBuckets.get(tenantId);
    }

    /**
     * Close connection for a specific tenant
     * @param {string} tenantId
     * @returns {Promise<void>}
     */
    async disconnectTenantAsync (tenantId) {
        const cached = this.connectionPool.get(tenantId);
        if (cached) {
            try {
                await cached.client.close(true);
                logInfo('Tenant database disconnected', { tenantId });
            } catch (err) {
                logError('Error disconnecting tenant database', { tenantId, error: err });
            }
            this.connectionPool.delete(tenantId);
            this.gridFsBuckets.delete(tenantId);
        }
    }

    /**
     * Close idle tenant connections that haven't been used within maxIdleTimeMs
     * @returns {Promise<number>} Number of connections closed
     */
    async cleanupIdleConnectionsAsync () {
        const now = Date.now();
        let closedCount = 0;

        for (const [tenantId, entry] of this.connectionPool) {
            if ((now - entry.lastAccessed) > this.maxIdleTimeMs) {
                await this.disconnectTenantAsync(tenantId);
                closedCount++;
            }
        }

        if (closedCount > 0) {
            logInfo('Cleaned up idle tenant connections', { closedCount });
        }

        return closedCount;
    }

    /**
     * Close all tenant connections
     * @returns {Promise<void>}
     */
    async disconnectAllAsync () {
        for (const tenantId of this.connectionPool.keys()) {
            await this.disconnectTenantAsync(tenantId);
        }

        if (this.platformClient) {
            await this.platformClient.close(true);
            this.platformClient = null;
        }
    }

    /**
     * Get the number of active tenant connections
     * @returns {number}
     */
    getActiveConnectionCount () {
        return this.connectionPool.size;
    }

    /**
     * Health check for a tenant's database connection
     * @param {string} tenantId
     * @returns {Promise<boolean>}
     */
    async healthCheckAsync (tenantId) {
        try {
            const cached = this.connectionPool.get(tenantId);
            if (!cached) {
                return false;
            }
            await cached.client.db('admin').command({ ping: 1 });
            return true;
        } catch {
            return false;
        }
    }
}

module.exports = { TenantDatabaseManager };
