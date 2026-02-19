/**
 * TenantProvisioningService - Handles database and realm provisioning for new tenants
 *
 * When a new tenant is created:
 * 1. Creates tenant-specific MongoDB databases (fhir_xxx, audit_xxx, history_xxx)
 * 2. Sets up initial indexes for the new databases
 * 3. Creates initial AuditEvent recording tenant creation
 * 4. Can provision Keycloak realm via API (stub for now)
 */
const { logInfo, logError } = require('../operations/common/logging');
const { generateUUID } = require('../utils/uid.util');
const { TenantDatabaseManager } = require('../multiTenancy/tenantDatabaseManager');
const { ConfigManager } = require('../utils/configManager');
const { assertTypeEquals } = require('../utils/assertType');

/**
 * @typedef TenantProvisioningServiceProps
 * @property {TenantDatabaseManager} tenantDatabaseManager
 * @property {ConfigManager} configManager
 */

class TenantProvisioningService {
    /**
     * @param {TenantProvisioningServiceProps} params
     */
    constructor ({ tenantDatabaseManager, configManager }) {
        /** @type {TenantDatabaseManager} */
        this.tenantDatabaseManager = tenantDatabaseManager;
        assertTypeEquals(tenantDatabaseManager, TenantDatabaseManager);

        /** @type {ConfigManager} */
        this.configManager = configManager;
        assertTypeEquals(configManager, ConfigManager);
    }

    /**
     * Provision all infrastructure for a new tenant
     * @param {import('../multiTenancy/tenantContext').TenantContext} tenantContext
     * @returns {Promise<{success: boolean, errors?: string[]}>}
     */
    async provisionTenantAsync (tenantContext) {
        const tenantId = tenantContext.tenantId;
        const errors = [];

        logInfo('Starting tenant provisioning', {
            tenantId,
            tenantType: tenantContext.tenantType
        });

        // Step 1: Provision MongoDB databases
        try {
            await this.provisionDatabasesAsync(tenantContext);
            logInfo('Databases provisioned', { tenantId });
        } catch (err) {
            logError('Failed to provision databases', { tenantId, error: err });
            errors.push(`Database provisioning failed: ${err.message}`);
        }

        // Step 2: Create indexes
        try {
            await this.createIndexesAsync(tenantContext);
            logInfo('Indexes created', { tenantId });
        } catch (err) {
            logError('Failed to create indexes', { tenantId, error: err });
            errors.push(`Index creation failed: ${err.message}`);
        }

        // Step 3: Create initial audit event
        try {
            await this.createInitialAuditEventAsync(tenantContext);
            logInfo('Initial audit event created', { tenantId });
        } catch (err) {
            logError('Failed to create initial audit event', { tenantId, error: err });
            errors.push(`Audit event creation failed: ${err.message}`);
        }

        // Step 4: Provision Keycloak realm (stub)
        try {
            await this.provisionKeycloakRealmAsync(tenantContext);
            logInfo('Keycloak realm provisioned', { tenantId });
        } catch (err) {
            logError('Failed to provision Keycloak realm', { tenantId, error: err });
            errors.push(`Keycloak provisioning failed: ${err.message}`);
        }

        const success = errors.length === 0;
        logInfo('Tenant provisioning completed', { tenantId, success, errors });

        return { success, errors: errors.length > 0 ? errors : undefined };
    }

    /**
     * Provision MongoDB databases for a tenant
     * @param {import('../multiTenancy/tenantContext').TenantContext} tenantContext
     */
    async provisionDatabasesAsync (tenantContext) {
        const tenantId = tenantContext.tenantId;

        // Creating a connection to each database effectively creates it in MongoDB
        const fhirDb = await this.tenantDatabaseManager.getFhirDbForTenantAsync(tenantId, tenantContext);
        const auditDb = await this.tenantDatabaseManager.getAuditDbForTenantAsync(tenantId, tenantContext);
        const historyDb = await this.tenantDatabaseManager.getHistoryDbForTenantAsync(tenantId, tenantContext);

        // Create a marker collection to ensure the database exists
        await fhirDb.createCollection('_tenant_metadata');
        await fhirDb.collection('_tenant_metadata').insertOne({
            tenantId,
            tenantType: tenantContext.tenantType,
            createdAt: new Date(),
            version: '1.0.0'
        });

        await auditDb.createCollection('_tenant_metadata');
        await auditDb.collection('_tenant_metadata').insertOne({
            tenantId,
            dbType: 'audit',
            createdAt: new Date()
        });

        await historyDb.createCollection('_tenant_metadata');
        await historyDb.collection('_tenant_metadata').insertOne({
            tenantId,
            dbType: 'history',
            createdAt: new Date()
        });
    }

    /**
     * Create standard FHIR indexes for a tenant's databases
     * @param {import('../multiTenancy/tenantContext').TenantContext} tenantContext
     */
    async createIndexesAsync (tenantContext) {
        const tenantId = tenantContext.tenantId;
        const fhirDb = await this.tenantDatabaseManager.getFhirDbForTenantAsync(tenantId, tenantContext);

        // Core FHIR resource indexes for PA workflow resources
        const paResourceTypes = [
            'Patient', 'Practitioner', 'PractitionerRole', 'Organization',
            'Coverage', 'Claim', 'ClaimResponse', 'ServiceRequest',
            'DeviceRequest', 'MedicationRequest', 'Task',
            'QuestionnaireResponse', 'DocumentReference', 'Condition',
            'Observation', 'Provenance', 'Subscription'
        ];

        for (const resourceType of paResourceTypes) {
            const collection = fhirDb.collection(resourceType);

            // Standard indexes
            await collection.createIndex({ id: 1 }, { unique: true, background: true });
            await collection.createIndex({ 'meta.lastUpdated': -1 }, { background: true });
            await collection.createIndex(
                { 'meta.security.system': 1, 'meta.security.code': 1 },
                { background: true }
            );
        }

        // PA-specific indexes
        const claimCollection = fhirDb.collection('Claim');
        await claimCollection.createIndex({ use: 1, status: 1 }, { background: true });
        await claimCollection.createIndex({ 'identifier.value': 1 }, { background: true });

        const claimResponseCollection = fhirDb.collection('ClaimResponse');
        await claimResponseCollection.createIndex(
            { 'request.reference': 1 },
            { background: true }
        );
        await claimResponseCollection.createIndex(
            { outcome: 1, status: 1 },
            { background: true }
        );

        // AuditEvent indexes
        const auditDb = await this.tenantDatabaseManager.getAuditDbForTenantAsync(tenantId, tenantContext);
        const auditCollection = auditDb.collection('AuditEvent');
        await auditCollection.createIndex({ id: 1 }, { unique: true, background: true });
        await auditCollection.createIndex({ recorded: -1 }, { background: true });
        await auditCollection.createIndex({ 'entity.detail.type': 1, 'entity.detail.valueString': 1 }, { background: true });
    }

    /**
     * Create initial AuditEvent recording tenant creation
     * @param {import('../multiTenancy/tenantContext').TenantContext} tenantContext
     */
    async createInitialAuditEventAsync (tenantContext) {
        const tenantId = tenantContext.tenantId;
        const auditDb = await this.tenantDatabaseManager.getAuditDbForTenantAsync(tenantId, tenantContext);

        const auditEvent = {
            resourceType: 'AuditEvent',
            id: generateUUID(),
            meta: {
                lastUpdated: new Date().toISOString(),
                security: [{ system: 'https://platform.example.com/tenant', code: tenantId }]
            },
            type: {
                system: 'http://dicom.nema.org/resources/ontology/DCM',
                code: '110100',
                display: 'Application Activity'
            },
            subtype: [{
                system: 'http://dicom.nema.org/resources/ontology/DCM',
                code: '110120',
                display: 'Application Start'
            }],
            action: 'E',
            recorded: new Date().toISOString(),
            outcome: '0',
            outcomeDesc: 'Tenant provisioned successfully',
            agent: [{
                type: {
                    coding: [{
                        system: 'http://dicom.nema.org/resources/ontology/DCM',
                        code: '110150',
                        display: 'Application'
                    }]
                },
                who: { display: 'FHIR Prior Authorization Platform' },
                requestor: false
            }],
            source: {
                site: tenantId,
                observer: { display: 'Device/fhir-platform' },
                type: [{
                    system: 'http://terminology.hl7.org/CodeSystem/security-source-type',
                    code: '4',
                    display: 'Application Server'
                }]
            },
            entity: [{
                what: { display: `Tenant/${tenantId}` },
                type: {
                    system: 'http://terminology.hl7.org/CodeSystem/audit-entity-type',
                    code: '2',
                    display: 'System Object'
                },
                detail: [
                    { type: 'tenantId', valueString: tenantId },
                    { type: 'tenantType', valueString: tenantContext.tenantType },
                    { type: 'action', valueString: 'tenant-provisioned' }
                ]
            }]
        };

        await auditDb.collection('AuditEvent').insertOne(auditEvent);
    }

    /**
     * Provision Keycloak realm for a tenant (stub)
     * @param {import('../multiTenancy/tenantContext').TenantContext} tenantContext
     */
    async provisionKeycloakRealmAsync (tenantContext) {
        // TODO: Implement Keycloak realm provisioning via Keycloak Admin REST API
        // This would:
        // 1. Create a new realm named after the tenant
        // 2. Configure SMART on FHIR client scopes
        // 3. Set up Backend Services client authentication
        // 4. Configure token lifetimes and policies
        logInfo('Keycloak realm provisioning (stub)', {
            tenantId: tenantContext.tenantId,
            realmName: tenantContext.auth?.keycloakRealm || tenantContext.tenantId
        });
    }

    /**
     * Decommission a tenant's infrastructure
     * @param {string} tenantId
     * @returns {Promise<{success: boolean, errors?: string[]}>}
     */
    async decommissionTenantAsync (tenantId) {
        logInfo('Starting tenant decommission', { tenantId });

        try {
            // Close database connections for this tenant
            await this.tenantDatabaseManager.disconnectTenantAsync(tenantId);

            // Note: We do NOT drop databases during decommission for compliance/retention
            // Data is retained per CMS-0057-F requirements (7 years minimum)
            logInfo('Tenant decommissioned (connections closed, data retained)', { tenantId });

            return { success: true };
        } catch (err) {
            logError('Failed to decommission tenant', { tenantId, error: err });
            return { success: false, errors: [err.message] };
        }
    }
}

module.exports = { TenantProvisioningService };
