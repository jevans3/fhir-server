/**
 * TenantProvisioningService - Handles database and infrastructure provisioning
 * for new tenants during the onboarding process.
 *
 * When a new tenant is created, this service:
 *   1. Creates tenant-specific MongoDB databases (fhir_xxx, audit_xxx, history_xxx)
 *   2. Sets up initial indexes for the new databases
 *   3. Creates an initial AuditEvent recording the tenant creation
 *   4. Optionally provisions a Keycloak realm for the tenant's auth (stubbed)
 *
 * This service is designed to be called after TenantService.createTenantAsync()
 * successfully creates the tenant record in the platform config database.
 */

const { TenantDatabaseManager } = require('../multiTenancy/tenantDatabaseManager');
const { ConfigManager } = require('../utils/configManager');
const { assertTypeEquals } = require('../utils/assertType');
const { generateUUID } = require('../utils/uid.util');
const { logInfo, logError } = require('../operations/common/logging');

/**
 * Standard indexes to create on FHIR resource collections.
 * These cover the most common search parameters per the FHIR R4 spec
 * and CMS-0057-F prior authorization query patterns.
 * @type {Array<{collection: string, indexes: Array<{key: Object, options?: Object}>}>}
 */
const FHIR_DB_INITIAL_INDEXES = [
    {
        collection: 'Claim_4_0_0',
        indexes: [
            { key: { 'meta.lastUpdated': 1 }, options: { name: 'idx_meta_lastUpdated' } },
            { key: { 'identifier.value': 1, 'identifier.system': 1 }, options: { name: 'idx_identifier' } },
            { key: { 'patient.reference': 1 }, options: { name: 'idx_patient_ref' } },
            { key: { 'provider.reference': 1 }, options: { name: 'idx_provider_ref' } },
            { key: { 'insurer.reference': 1 }, options: { name: 'idx_insurer_ref' } },
            { key: { status: 1 }, options: { name: 'idx_status' } },
            { key: { created: 1 }, options: { name: 'idx_created' } },
            { key: { use: 1, status: 1 }, options: { name: 'idx_use_status' } },
            { key: { '_access.bwell': 1 }, options: { name: 'idx_access_bwell', sparse: true } },
            { key: { '_uuid': 1 }, options: { name: 'idx_uuid', unique: true } }
        ]
    },
    {
        collection: 'ClaimResponse_4_0_0',
        indexes: [
            { key: { 'meta.lastUpdated': 1 }, options: { name: 'idx_meta_lastUpdated' } },
            { key: { 'identifier.value': 1, 'identifier.system': 1 }, options: { name: 'idx_identifier' } },
            { key: { 'patient.reference': 1 }, options: { name: 'idx_patient_ref' } },
            { key: { 'insurer.reference': 1 }, options: { name: 'idx_insurer_ref' } },
            { key: { 'request.reference': 1 }, options: { name: 'idx_request_ref' } },
            { key: { status: 1 }, options: { name: 'idx_status' } },
            { key: { outcome: 1, status: 1 }, options: { name: 'idx_outcome_status' } },
            { key: { '_uuid': 1 }, options: { name: 'idx_uuid', unique: true } }
        ]
    },
    {
        collection: 'Patient_4_0_0',
        indexes: [
            { key: { 'meta.lastUpdated': 1 }, options: { name: 'idx_meta_lastUpdated' } },
            { key: { 'identifier.value': 1, 'identifier.system': 1 }, options: { name: 'idx_identifier' } },
            { key: { 'name.family': 1, 'name.given': 1 }, options: { name: 'idx_name' } },
            { key: { birthDate: 1 }, options: { name: 'idx_birthDate' } },
            { key: { '_uuid': 1 }, options: { name: 'idx_uuid', unique: true } }
        ]
    },
    {
        collection: 'Practitioner_4_0_0',
        indexes: [
            { key: { 'meta.lastUpdated': 1 }, options: { name: 'idx_meta_lastUpdated' } },
            { key: { 'identifier.value': 1, 'identifier.system': 1 }, options: { name: 'idx_identifier' } },
            { key: { '_uuid': 1 }, options: { name: 'idx_uuid', unique: true } }
        ]
    },
    {
        collection: 'Organization_4_0_0',
        indexes: [
            { key: { 'meta.lastUpdated': 1 }, options: { name: 'idx_meta_lastUpdated' } },
            { key: { 'identifier.value': 1, 'identifier.system': 1 }, options: { name: 'idx_identifier' } },
            { key: { '_uuid': 1 }, options: { name: 'idx_uuid', unique: true } }
        ]
    },
    {
        collection: 'Coverage_4_0_0',
        indexes: [
            { key: { 'meta.lastUpdated': 1 }, options: { name: 'idx_meta_lastUpdated' } },
            { key: { 'beneficiary.reference': 1 }, options: { name: 'idx_beneficiary_ref' } },
            { key: { 'payor.reference': 1 }, options: { name: 'idx_payor_ref' } },
            { key: { status: 1 }, options: { name: 'idx_status' } },
            { key: { '_uuid': 1 }, options: { name: 'idx_uuid', unique: true } }
        ]
    },
    {
        collection: 'Task_4_0_0',
        indexes: [
            { key: { 'meta.lastUpdated': 1 }, options: { name: 'idx_meta_lastUpdated' } },
            { key: { status: 1 }, options: { name: 'idx_status' } },
            { key: { 'owner.reference': 1 }, options: { name: 'idx_owner_ref' } },
            { key: { 'requester.reference': 1 }, options: { name: 'idx_requester_ref' } },
            { key: { '_uuid': 1 }, options: { name: 'idx_uuid', unique: true } }
        ]
    },
    {
        collection: 'ServiceRequest_4_0_0',
        indexes: [
            { key: { 'meta.lastUpdated': 1 }, options: { name: 'idx_meta_lastUpdated' } },
            { key: { status: 1 }, options: { name: 'idx_status' } },
            { key: { 'subject.reference': 1 }, options: { name: 'idx_subject_ref' } },
            { key: { '_uuid': 1 }, options: { name: 'idx_uuid', unique: true } }
        ]
    },
    {
        collection: 'QuestionnaireResponse_4_0_0',
        indexes: [
            { key: { 'meta.lastUpdated': 1 }, options: { name: 'idx_meta_lastUpdated' } },
            { key: { status: 1 }, options: { name: 'idx_status' } },
            { key: { 'questionnaire': 1 }, options: { name: 'idx_questionnaire' } },
            { key: { '_uuid': 1 }, options: { name: 'idx_uuid', unique: true } }
        ]
    },
    {
        collection: 'DocumentReference_4_0_0',
        indexes: [
            { key: { 'meta.lastUpdated': 1 }, options: { name: 'idx_meta_lastUpdated' } },
            { key: { status: 1 }, options: { name: 'idx_status' } },
            { key: { 'subject.reference': 1 }, options: { name: 'idx_subject_ref' } },
            { key: { '_uuid': 1 }, options: { name: 'idx_uuid', unique: true } }
        ]
    },
    {
        collection: 'Subscription_4_0_0',
        indexes: [
            { key: { status: 1 }, options: { name: 'idx_status' } },
            { key: { '_uuid': 1 }, options: { name: 'idx_uuid', unique: true } }
        ]
    }
];

/**
 * Standard indexes for the audit database
 * @type {Array<{collection: string, indexes: Array<{key: Object, options?: Object}>}>}
 */
const AUDIT_DB_INITIAL_INDEXES = [
    {
        collection: 'AuditEvent_4_0_0',
        indexes: [
            { key: { recorded: -1 }, options: { name: 'idx_recorded' } },
            { key: { 'type.code': 1 }, options: { name: 'idx_type_code' } },
            { key: { 'agent.who.reference': 1 }, options: { name: 'idx_agent_who_ref' } },
            { key: { 'entity.what.reference': 1 }, options: { name: 'idx_entity_what_ref' } },
            {
                key: { 'entity.detail.type': 1, 'entity.detail.valueString': 1 },
                options: { name: 'idx_entity_detail', sparse: true }
            },
            { key: { 'meta.security.code': 1 }, options: { name: 'idx_meta_security_code' } },
            { key: { action: 1 }, options: { name: 'idx_action' } },
            { key: { outcome: 1 }, options: { name: 'idx_outcome' } },
            { key: { '_uuid': 1 }, options: { name: 'idx_uuid', unique: true } },
            {
                key: { recorded: 1 },
                options: {
                    name: 'idx_recorded_ttl',
                    // 7 years (2555 days) per CMS-0057-F data retention requirements
                    expireAfterSeconds: 220752000
                }
            }
        ]
    }
];

/**
 * Standard indexes for the history database
 * @type {Array<{collection: string, indexes: Array<{key: Object, options?: Object}>}>}
 */
const HISTORY_DB_INITIAL_INDEXES = [
    {
        collection: 'Claim_4_0_0_History',
        indexes: [
            { key: { 'resource.id': 1, 'resource.meta.versionId': 1 }, options: { name: 'idx_resource_version' } },
            { key: { 'resource.meta.lastUpdated': -1 }, options: { name: 'idx_meta_lastUpdated' } }
        ]
    },
    {
        collection: 'ClaimResponse_4_0_0_History',
        indexes: [
            { key: { 'resource.id': 1, 'resource.meta.versionId': 1 }, options: { name: 'idx_resource_version' } },
            { key: { 'resource.meta.lastUpdated': -1 }, options: { name: 'idx_meta_lastUpdated' } }
        ]
    },
    {
        collection: 'Patient_4_0_0_History',
        indexes: [
            { key: { 'resource.id': 1, 'resource.meta.versionId': 1 }, options: { name: 'idx_resource_version' } },
            { key: { 'resource.meta.lastUpdated': -1 }, options: { name: 'idx_meta_lastUpdated' } }
        ]
    }
];

/**
 * @typedef TenantProvisioningServiceParams
 * @property {TenantDatabaseManager} tenantDatabaseManager
 * @property {ConfigManager} configManager
 */

class TenantProvisioningService {
    /**
     * @param {TenantProvisioningServiceParams} params
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
     * Provision all infrastructure for a new tenant.
     *
     * This is the main entry point called after a tenant record has been
     * created in the platform config database. It orchestrates the full
     * provisioning workflow.
     *
     * @param {Object} params
     * @param {string} params.tenantId - Tenant identifier
     * @param {string} [params.tenantName] - Tenant display name
     * @param {Object} [params.tenantContext] - Optional tenant context with database config
     * @param {string} [params.provisionedBy] - Admin identity who triggered provisioning
     * @returns {Promise<{success: boolean, databases?: Object, errors?: string[]}>}
     */
    async provisionTenantAsync ({ tenantId, tenantName, tenantContext, provisionedBy }) {
        const errors = [];
        const provisioningResult = {
            fhirDb: null,
            auditDb: null,
            historyDb: null,
            indexesCreated: 0,
            keycloakRealm: null
        };

        logInfo('Starting tenant provisioning', { tenantId, provisionedBy });

        try {
            // Step 1: Create tenant-specific databases
            const dbResult = await this._provisionDatabasesAsync({ tenantId, tenantContext });
            if (!dbResult.success) {
                errors.push(...dbResult.errors);
                return { success: false, errors };
            }
            provisioningResult.fhirDb = dbResult.fhirDbName;
            provisioningResult.auditDb = dbResult.auditDbName;
            provisioningResult.historyDb = dbResult.historyDbName;

            // Step 2: Create initial indexes
            const indexResult = await this._createInitialIndexesAsync({ tenantId, tenantContext });
            provisioningResult.indexesCreated = indexResult.totalIndexes;
            if (indexResult.errors.length > 0) {
                // Index creation failures are non-fatal warnings
                logError('Some indexes failed during tenant provisioning', {
                    tenantId,
                    errors: indexResult.errors
                });
            }

            // Step 3: Create initial audit event
            await this._createProvisioningAuditEventAsync({
                tenantId,
                tenantName,
                tenantContext,
                provisionedBy: provisionedBy || 'system'
            });

            // Step 4: Provision Keycloak realm (stub)
            const keycloakResult = await this._provisionKeycloakRealmAsync({ tenantId, tenantName });
            provisioningResult.keycloakRealm = keycloakResult.realmName;

            logInfo('Tenant provisioning completed', {
                tenantId,
                databases: {
                    fhir: provisioningResult.fhirDb,
                    audit: provisioningResult.auditDb,
                    history: provisioningResult.historyDb
                },
                indexesCreated: provisioningResult.indexesCreated,
                provisionedBy
            });

            return {
                success: true,
                databases: provisioningResult
            };
        } catch (err) {
            logError('Tenant provisioning failed', { tenantId, error: err });
            errors.push(`Provisioning failed: ${err.message}`);
            return { success: false, databases: provisioningResult, errors };
        }
    }

    /**
     * Create tenant-specific MongoDB databases.
     *
     * MongoDB databases are created lazily on first write, so we explicitly
     * access them and insert a sentinel document to force creation.
     *
     * @param {Object} params
     * @param {string} params.tenantId
     * @param {Object} [params.tenantContext]
     * @returns {Promise<{success: boolean, fhirDbName?: string, auditDbName?: string, historyDbName?: string, errors?: string[]}>}
     * @private
     */
    async _provisionDatabasesAsync ({ tenantId, tenantContext }) {
        const sanitizedId = tenantId.replace(/-/g, '_');
        const fhirDbName = `fhir_${sanitizedId}`;
        const auditDbName = `audit_${sanitizedId}`;
        const historyDbName = `history_${sanitizedId}`;

        try {
            // Access each database to trigger connection establishment
            const fhirDb = await this.tenantDatabaseManager.getFhirDbForTenantAsync(tenantId, tenantContext);
            const auditDb = await this.tenantDatabaseManager.getAuditDbForTenantAsync(tenantId, tenantContext);
            const historyDb = await this.tenantDatabaseManager.getHistoryDbForTenantAsync(tenantId, tenantContext);

            // Create a sentinel collection in each database to force database creation.
            // MongoDB does not create a database until the first document is written.
            const now = new Date();
            const sentinelDoc = {
                _id: `_provisioning_${tenantId}`,
                type: 'provisioning_marker',
                tenantId,
                provisionedAt: now,
                version: '1.0.0'
            };

            await fhirDb.collection('_system').insertOne({ ...sentinelDoc, dbType: 'fhir' });
            await auditDb.collection('_system').insertOne({ ...sentinelDoc, dbType: 'audit' });
            await historyDb.collection('_system').insertOne({ ...sentinelDoc, dbType: 'history' });

            logInfo('Tenant databases provisioned', {
                tenantId,
                fhirDb: fhirDbName,
                auditDb: auditDbName,
                historyDb: historyDbName
            });

            return {
                success: true,
                fhirDbName,
                auditDbName,
                historyDbName
            };
        } catch (err) {
            logError('Failed to provision databases for tenant', { tenantId, error: err });
            return {
                success: false,
                errors: [`Database provisioning failed: ${err.message}`]
            };
        }
    }

    /**
     * Create initial indexes on the tenant's databases.
     *
     * @param {Object} params
     * @param {string} params.tenantId
     * @param {Object} [params.tenantContext]
     * @returns {Promise<{totalIndexes: number, errors: string[]}>}
     * @private
     */
    async _createInitialIndexesAsync ({ tenantId, tenantContext }) {
        let totalIndexes = 0;
        const errors = [];

        try {
            // FHIR database indexes
            const fhirDb = await this.tenantDatabaseManager.getFhirDbForTenantAsync(tenantId, tenantContext);
            for (const collectionDef of FHIR_DB_INITIAL_INDEXES) {
                for (const indexDef of collectionDef.indexes) {
                    try {
                        await fhirDb.collection(collectionDef.collection).createIndex(
                            indexDef.key,
                            indexDef.options || {}
                        );
                        totalIndexes++;
                    } catch (err) {
                        errors.push(
                            `Failed to create index ${indexDef.options?.name || 'unnamed'} ` +
                            `on ${collectionDef.collection}: ${err.message}`
                        );
                    }
                }
            }

            // Audit database indexes
            const auditDb = await this.tenantDatabaseManager.getAuditDbForTenantAsync(tenantId, tenantContext);
            for (const collectionDef of AUDIT_DB_INITIAL_INDEXES) {
                for (const indexDef of collectionDef.indexes) {
                    try {
                        await auditDb.collection(collectionDef.collection).createIndex(
                            indexDef.key,
                            indexDef.options || {}
                        );
                        totalIndexes++;
                    } catch (err) {
                        errors.push(
                            `Failed to create index ${indexDef.options?.name || 'unnamed'} ` +
                            `on ${collectionDef.collection}: ${err.message}`
                        );
                    }
                }
            }

            // History database indexes
            const historyDb = await this.tenantDatabaseManager.getHistoryDbForTenantAsync(tenantId, tenantContext);
            for (const collectionDef of HISTORY_DB_INITIAL_INDEXES) {
                for (const indexDef of collectionDef.indexes) {
                    try {
                        await historyDb.collection(collectionDef.collection).createIndex(
                            indexDef.key,
                            indexDef.options || {}
                        );
                        totalIndexes++;
                    } catch (err) {
                        errors.push(
                            `Failed to create index ${indexDef.options?.name || 'unnamed'} ` +
                            `on ${collectionDef.collection}: ${err.message}`
                        );
                    }
                }
            }

            logInfo('Initial indexes created for tenant', {
                tenantId,
                totalIndexes,
                errorCount: errors.length
            });
        } catch (err) {
            errors.push(`Index creation failed: ${err.message}`);
            logError('Failed to create indexes for tenant', { tenantId, error: err });
        }

        return { totalIndexes, errors };
    }

    /**
     * Create an initial AuditEvent recording the tenant creation.
     *
     * This audit event is inserted directly into the tenant's audit database
     * as the first record, documenting when and by whom the tenant was
     * provisioned.
     *
     * @param {Object} params
     * @param {string} params.tenantId
     * @param {string} [params.tenantName]
     * @param {Object} [params.tenantContext]
     * @param {string} params.provisionedBy
     * @returns {Promise<void>}
     * @private
     */
    async _createProvisioningAuditEventAsync ({ tenantId, tenantName, tenantContext, provisionedBy }) {
        try {
            const auditDb = await this.tenantDatabaseManager.getAuditDbForTenantAsync(tenantId, tenantContext);
            const now = new Date();

            const auditEvent = {
                resourceType: 'AuditEvent',
                id: generateUUID(),
                meta: {
                    versionId: '1',
                    lastUpdated: now.toISOString(),
                    security: [
                        {
                            system: 'https://www.icanbwell.com/owner',
                            code: tenantId
                        },
                        {
                            system: 'https://www.icanbwell.com/access',
                            code: tenantId
                        }
                    ]
                },
                type: {
                    system: 'http://dicom.nema.org/resources/ontology/DCM',
                    code: '110100',
                    display: 'Application Activity'
                },
                subtype: [{
                    system: 'https://fhir.icanbwell.com/CodeSystem/tenant-lifecycle',
                    code: 'provisioned',
                    display: 'Tenant Provisioned'
                }],
                action: 'C',
                recorded: now.toISOString(),
                outcome: '0',
                outcomeDesc: `Tenant '${tenantId}' provisioned successfully.`,
                agent: [
                    {
                        who: { reference: `Practitioner/${provisionedBy}` },
                        requestor: true,
                        name: provisionedBy
                    },
                    {
                        who: { reference: 'Device/fhir-platform' },
                        requestor: false,
                        name: 'FHIR Prior Authorization Platform'
                    }
                ],
                source: {
                    site: tenantName || tenantId,
                    observer: { reference: 'Device/fhir-platform' },
                    type: [{
                        system: 'http://terminology.hl7.org/CodeSystem/security-source-type',
                        code: '4',
                        display: 'Application Server'
                    }]
                },
                entity: [{
                    what: { reference: `Organization/${tenantId}` },
                    type: {
                        system: 'http://terminology.hl7.org/CodeSystem/audit-entity-type',
                        code: '2',
                        display: 'System Object'
                    },
                    role: {
                        system: 'http://terminology.hl7.org/CodeSystem/object-role',
                        code: '4',
                        display: 'Domain Resource'
                    },
                    name: tenantName || tenantId,
                    detail: [
                        { type: 'tenantId', valueString: tenantId },
                        { type: 'action', valueString: 'provision' },
                        { type: 'provisionedBy', valueString: provisionedBy },
                        { type: 'provisionedAt', valueString: now.toISOString() }
                    ]
                }],
                extension: [{
                    url: 'https://fhir.icanbwell.com/4_0_0/StructureDefinition/correlation-tracking',
                    extension: [
                        {
                            url: 'https://fhir.icanbwell.com/4_0_0/StructureDefinition/correlation-tracking/correlationId',
                            valueString: generateUUID()
                        },
                        {
                            url: 'https://fhir.icanbwell.com/4_0_0/StructureDefinition/correlation-tracking/workflowStage',
                            valueString: 'tenant-lifecycle'
                        }
                    ]
                }]
            };

            await auditDb.collection('AuditEvent_4_0_0').insertOne(auditEvent);

            logInfo('Provisioning audit event created', {
                tenantId,
                auditEventId: auditEvent.id,
                provisionedBy
            });
        } catch (err) {
            // Audit event creation failure is non-fatal
            logError('Failed to create provisioning audit event', {
                tenantId,
                error: err
            });
        }
    }

    /**
     * Provision a Keycloak realm for the tenant's authentication.
     *
     * This is currently a stub that returns a placeholder result.
     * In production, this would call the Keycloak Admin REST API to:
     *   - Create a new realm named after the tenant
     *   - Configure SMART on FHIR client scopes
     *   - Set up token exchange policies
     *   - Configure private_key_jwt authentication
     *
     * @param {Object} params
     * @param {string} params.tenantId
     * @param {string} [params.tenantName]
     * @returns {Promise<{success: boolean, realmName: string|null, errors?: string[]}>}
     * @private
     */
    async _provisionKeycloakRealmAsync ({ tenantId, tenantName }) {
        const realmName = tenantId;

        try {
            // TODO: Implement actual Keycloak realm provisioning via Admin REST API
            // const keycloakAdminUrl = this.configManager.keycloakAdminUrl;
            // const realmConfig = {
            //     realm: realmName,
            //     displayName: tenantName || tenantId,
            //     enabled: true,
            //     sslRequired: 'external',
            //     registrationAllowed: false,
            //     loginWithEmailAllowed: false,
            //     duplicateEmailsAllowed: false,
            //     resetPasswordAllowed: false,
            //     editUsernameAllowed: false,
            //     bruteForceProtected: true,
            //     accessTokenLifespan: 300,
            //     ssoSessionIdleTimeout: 1800,
            //     ssoSessionMaxLifespan: 36000,
            //     clientScopes: [
            //         { name: 'system/*.cruds', protocol: 'openid-connect' },
            //         { name: 'patient/*.rs', protocol: 'openid-connect' },
            //         { name: 'user/*.cruds', protocol: 'openid-connect' }
            //     ]
            // };

            logInfo('Keycloak realm provisioning stubbed', {
                tenantId,
                realmName,
                note: 'Actual Keycloak provisioning not yet implemented'
            });

            return {
                success: true,
                realmName
            };
        } catch (err) {
            logError('Failed to provision Keycloak realm', { tenantId, error: err });
            return {
                success: false,
                realmName: null,
                errors: [`Keycloak provisioning failed: ${err.message}`]
            };
        }
    }

    /**
     * Deprovision (tear down) a tenant's databases.
     *
     * WARNING: This is a destructive operation that drops all tenant databases.
     * Should only be used in testing or when a tenant is permanently removed.
     * For compliance decommissioning, use decommissionTenantAsync() instead,
     * which retains data per CMS-0057-F 7-year retention requirements.
     *
     * @param {Object} params
     * @param {string} params.tenantId
     * @param {Object} [params.tenantContext]
     * @returns {Promise<{success: boolean, errors?: string[]}>}
     */
    async deprovisionTenantAsync ({ tenantId, tenantContext }) {
        try {
            logInfo('Starting tenant deprovisioning', { tenantId });

            const fhirDb = await this.tenantDatabaseManager.getFhirDbForTenantAsync(tenantId, tenantContext);
            const auditDb = await this.tenantDatabaseManager.getAuditDbForTenantAsync(tenantId, tenantContext);
            const historyDb = await this.tenantDatabaseManager.getHistoryDbForTenantAsync(tenantId, tenantContext);

            await fhirDb.dropDatabase();
            await auditDb.dropDatabase();
            await historyDb.dropDatabase();

            await this.tenantDatabaseManager.disconnectTenantAsync(tenantId);

            logInfo('Tenant deprovisioned', { tenantId });
            return { success: true };
        } catch (err) {
            logError('Failed to deprovision tenant', { tenantId, error: err });
            return { success: false, errors: [`Deprovisioning failed: ${err.message}`] };
        }
    }

    /**
     * Decommission a tenant's infrastructure without data loss.
     *
     * Closes database connections but retains all data per CMS-0057-F
     * minimum 7-year data retention requirements.
     *
     * @param {string} tenantId
     * @returns {Promise<{success: boolean, errors?: string[]}>}
     */
    async decommissionTenantAsync (tenantId) {
        logInfo('Starting tenant decommission', { tenantId });

        try {
            // Close database connections for this tenant
            await this.tenantDatabaseManager.disconnectTenantAsync(tenantId);

            // Data is retained per CMS-0057-F requirements (7 years minimum)
            logInfo('Tenant decommissioned (connections closed, data retained)', { tenantId });

            return { success: true };
        } catch (err) {
            logError('Failed to decommission tenant', { tenantId, error: err });
            return { success: false, errors: [err.message] };
        }
    }
}

module.exports = {
    TenantProvisioningService,
    FHIR_DB_INITIAL_INDEXES,
    AUDIT_DB_INITIAL_INDEXES,
    HISTORY_DB_INITIAL_INDEXES
};
