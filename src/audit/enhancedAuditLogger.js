/**
 * EnhancedAuditLogger - CMS-compliant AuditEvent creation service
 *
 * Extends the existing AuditLogger pattern from src/utils/auditLogger.js to produce
 * FHIR R4 AuditEvent resources that satisfy CMS-0057-F (Prior Authorization API)
 * audit requirements. Each AuditEvent captures:
 *   - Tenant context for multi-tenant isolation
 *   - Correlation ID for end-to-end Da Vinci workflow tracing (CRD -> DTR -> PAS -> CDex)
 *   - Workflow stage identification
 *   - X12 278 transaction identifiers when applicable
 *   - Full FHIR agent, source, and entity details
 *
 * This logger is designed to work alongside (not replace) the existing AuditLogger,
 * providing richer CMS-compliant audit data for prior authorization and payer exchange
 * workflows while maintaining backward compatibility.
 */

const { PostRequestProcessor } = require('../utils/postRequestProcessor');
const { ConfigManager } = require('../utils/configManager');
const { CorrelationIdManager } = require('../tracing/correlationIdManager');
const { assertTypeEquals } = require('../utils/assertType');
const { generateUUID } = require('../utils/uid.util');
const { logInfo, logError } = require('../operations/common/logging');
const {
    AuditEventBuilder,
    AUDIT_TYPE_CODES,
    AUDIT_SUBTYPE_CODES,
    AUDIT_ACTION_CODES,
    AUDIT_OUTCOME_CODES,
    AUDIT_SOURCE_TYPE_CODES,
    AUDIT_ENTITY_TYPE_CODES,
    AUDIT_ENTITY_ROLE_CODES
} = require('./auditEventBuilder');

/**
 * Maps FHIR operation names to AuditEvent action codes
 * @type {Object<string, string>}
 */
const OPERATION_TO_ACTION_MAP = {
    create: AUDIT_ACTION_CODES.CREATE,
    read: AUDIT_ACTION_CODES.READ,
    vread: AUDIT_ACTION_CODES.READ,
    update: AUDIT_ACTION_CODES.UPDATE,
    patch: AUDIT_ACTION_CODES.UPDATE,
    delete: AUDIT_ACTION_CODES.DELETE,
    search: AUDIT_ACTION_CODES.READ,
    history: AUDIT_ACTION_CODES.READ,
    execute: AUDIT_ACTION_CODES.EXECUTE,
    merge: AUDIT_ACTION_CODES.UPDATE,
    '$submit': AUDIT_ACTION_CODES.EXECUTE,
    '$inquire': AUDIT_ACTION_CODES.READ,
    '$submit-attachment': AUDIT_ACTION_CODES.CREATE,
    batch: AUDIT_ACTION_CODES.EXECUTE,
    transaction: AUDIT_ACTION_CODES.EXECUTE
};

/**
 * Maps FHIR operation names to AuditEvent subtype codes
 * @type {Object<string, Object>}
 */
const OPERATION_TO_SUBTYPE_MAP = {
    create: AUDIT_SUBTYPE_CODES.CREATE,
    read: AUDIT_SUBTYPE_CODES.READ,
    vread: AUDIT_SUBTYPE_CODES.VREAD,
    update: AUDIT_SUBTYPE_CODES.UPDATE,
    patch: AUDIT_SUBTYPE_CODES.UPDATE,
    delete: AUDIT_SUBTYPE_CODES.DELETE,
    search: AUDIT_SUBTYPE_CODES.SEARCH,
    history: AUDIT_SUBTYPE_CODES.HISTORY,
    execute: AUDIT_SUBTYPE_CODES.OPERATION,
    merge: AUDIT_SUBTYPE_CODES.UPDATE,
    '$submit': AUDIT_SUBTYPE_CODES.OPERATION,
    '$inquire': AUDIT_SUBTYPE_CODES.OPERATION,
    '$submit-attachment': AUDIT_SUBTYPE_CODES.OPERATION,
    batch: AUDIT_SUBTYPE_CODES.BATCH,
    transaction: AUDIT_SUBTYPE_CODES.TRANSACTION
};

class EnhancedAuditLogger {
    /**
     * Constructor
     * @typedef {Object} EnhancedAuditLoggerParams
     * @property {PostRequestProcessor} postRequestProcessor
     * @property {ConfigManager} configManager
     * @property {CorrelationIdManager} correlationIdManager
     *
     * @param {EnhancedAuditLoggerParams} params
     */
    constructor ({ postRequestProcessor, configManager, correlationIdManager }) {
        assertTypeEquals(postRequestProcessor, PostRequestProcessor);
        assertTypeEquals(configManager, ConfigManager);
        assertTypeEquals(correlationIdManager, CorrelationIdManager);

        /**
         * @type {PostRequestProcessor}
         */
        this.postRequestProcessor = postRequestProcessor;

        /**
         * @type {ConfigManager}
         */
        this.configManager = configManager;

        /**
         * @type {CorrelationIdManager}
         */
        this.correlationIdManager = correlationIdManager;
    }

    /**
     * Create a CMS-compliant AuditEvent for a FHIR interaction.
     *
     * This is the primary method for recording audit events that satisfy
     * CMS-0057-F requirements. It builds a complete FHIR R4 AuditEvent
     * with tenant isolation, correlation tracking, and workflow stage
     * identification.
     *
     * @param {Object} params
     * @param {string} params.requestId - Unique request identifier
     * @param {Object} params.requestInfo - FHIR request information
     * @param {string} params.requestInfo.user - User or system making the request
     * @param {boolean} [params.requestInfo.isUser] - Whether the actor is a human user
     * @param {string} [params.requestInfo.remoteIpAddress] - Client IP address
     * @param {string} [params.requestInfo.alternateUserId] - Alternate user identity
     * @param {string} [params.requestInfo.scope] - OAuth scopes
     * @param {string} params.resourceType - FHIR resource type being acted upon
     * @param {string} params.operation - FHIR operation name (create, read, update, delete, search, etc.)
     * @param {string[]} [params.resourceIds] - IDs of affected resources
     * @param {string} [params.tenantId] - Tenant identifier
     * @param {string} [params.tenantName] - Tenant display name
     * @param {string} [params.correlationId] - Correlation ID for workflow tracing
     * @param {string} [params.workflowStage] - Current Da Vinci workflow stage
     * @param {string} [params.parentCorrelationId] - Parent correlation ID for nested workflows
     * @param {string} [params.x12TransactionId] - X12 278 transaction control number
     * @param {string} [params.x12TraceNumber] - X12 TRN trace number
     * @param {string} [params.payerId] - Payer organization identifier
     * @param {string} [params.outcome] - Outcome code ('0'=success, '4'/'8'/'12'=failure)
     * @param {string} [params.outcomeDesc] - Human-readable outcome description
     * @param {Date} [params.periodStart] - When the event started
     * @param {Date} [params.periodEnd] - When the event ended
     * @returns {Object} FHIR R4 AuditEvent resource JSON
     */
    createAuditEvent ({
        requestId,
        requestInfo,
        resourceType,
        operation,
        resourceIds = [],
        tenantId,
        tenantName,
        correlationId,
        workflowStage,
        parentCorrelationId,
        x12TransactionId,
        x12TraceNumber,
        payerId,
        outcome,
        outcomeDesc,
        periodStart,
        periodEnd
    }) {
        const now = new Date();
        const actionCode = OPERATION_TO_ACTION_MAP[operation] || AUDIT_ACTION_CODES.EXECUTE;
        const subtypeCode = OPERATION_TO_SUBTYPE_MAP[operation] || AUDIT_SUBTYPE_CODES.OPERATION;

        // Resolve correlation context from the manager if not explicitly provided
        const currentContext = this.correlationIdManager.getCurrentContext();
        const resolvedCorrelationId = correlationId
            || (currentContext && currentContext.correlationId)
            || generateUUID();
        const resolvedWorkflowStage = workflowStage
            || (currentContext && currentContext.workflowStage)
            || 'FHIR-operation';

        // Determine the event type based on the operation category
        const eventType = this._resolveEventType(operation, resourceType);

        const builder = new AuditEventBuilder();

        // --- Type and Subtype ---
        builder
            .withType(eventType)
            .withSubtype([subtypeCode]);

        // --- Action ---
        builder.withAction(actionCode);

        // --- Period ---
        if (periodStart) {
            builder.withPeriod({
                start: periodStart,
                end: periodEnd || now
            });
        }

        // --- Recorded ---
        builder.withRecorded(now);

        // --- Outcome ---
        builder.withOutcome(
            outcome || AUDIT_OUTCOME_CODES.SUCCESS,
            outcomeDesc
        );

        // --- Agents ---
        // Agent 1: The practitioner / user / system that initiated the request (requestor=true)
        const actorReference = this._resolveActorReference(requestInfo);
        builder.withAgent({
            who: actorReference,
            requestor: true,
            altId: requestInfo.alternateUserId || undefined,
            name: requestInfo.user || undefined,
            network: requestInfo.remoteIpAddress
                ? { address: requestInfo.remoteIpAddress, type: '2' }
                : undefined
        });

        // Agent 2: The FHIR server platform device (requestor=false)
        builder.withAgent({
            who: 'Device/fhir-platform',
            requestor: false,
            name: 'FHIR Prior Authorization Platform',
            type: {
                coding: [{
                    system: 'http://dicom.nema.org/resources/ontology/DCM',
                    code: '110153',
                    display: 'Source Role ID'
                }]
            }
        });

        // --- Source ---
        builder.withSource({
            site: tenantName || tenantId || 'platform',
            observer: 'Device/fhir-platform',
            type: [AUDIT_SOURCE_TYPE_CODES.APPLICATION_SERVER]
        });

        // --- Entities (affected resources) ---
        const entityDetails = this._buildEntityDetails({
            correlationId: resolvedCorrelationId,
            workflowStage: resolvedWorkflowStage,
            tenantId,
            payerId,
            x12TransactionId,
            x12TraceNumber
        });

        if (resourceIds.length > 0) {
            resourceIds.forEach((resourceId, index) => {
                builder.withEntity({
                    what: `${resourceType}/${resourceId}`,
                    type: AUDIT_ENTITY_TYPE_CODES.SYSTEM_OBJECT,
                    role: AUDIT_ENTITY_ROLE_CODES.DOMAIN_RESOURCE,
                    detail: index === 0 ? entityDetails : undefined
                });
            });
        } else {
            // Even without specific resource IDs, create an entity for the resource type
            builder.withEntity({
                what: { reference: `${resourceType}` },
                type: AUDIT_ENTITY_TYPE_CODES.SYSTEM_OBJECT,
                role: AUDIT_ENTITY_ROLE_CODES.DOMAIN_RESOURCE,
                name: `${operation} on ${resourceType}`,
                detail: entityDetails
            });
        }

        // --- Correlation Extension ---
        builder.withCorrelation({
            correlationId: resolvedCorrelationId,
            traceId: currentContext && currentContext.traceId,
            spanId: currentContext && currentContext.spanId,
            workflowStage: resolvedWorkflowStage,
            parentCorrelationId
        });

        // --- Tenant ---
        if (tenantId) {
            builder.withTenant({ tenantId, tenantName });
        }

        return builder.build();
    }

    /**
     * Log an enhanced audit event asynchronously.
     *
     * Enqueues the audit event creation as a post-request task so that it
     * does not block the response to the client. The event is written after
     * the HTTP response has been sent.
     *
     * @param {Object} params - Same parameters as createAuditEvent
     * @param {string} params.requestId - Unique request identifier
     * @param {Object} params.requestInfo - FHIR request info
     * @param {string} params.resourceType - FHIR resource type
     * @param {string} params.operation - FHIR operation name
     * @param {string[]} [params.resourceIds] - IDs of affected resources
     * @param {string} [params.tenantId] - Tenant identifier
     * @param {string} [params.tenantName] - Tenant display name
     * @param {string} [params.correlationId] - Correlation ID
     * @param {string} [params.workflowStage] - Workflow stage
     * @param {string} [params.parentCorrelationId] - Parent correlation ID
     * @param {string} [params.x12TransactionId] - X12 transaction ID
     * @param {string} [params.x12TraceNumber] - X12 trace number
     * @param {string} [params.payerId] - Payer identifier
     * @param {string} [params.outcome] - Outcome code
     * @param {string} [params.outcomeDesc] - Outcome description
     * @param {Date} [params.periodStart] - Period start
     * @param {Date} [params.periodEnd] - Period end
     * @returns {void}
     */
    logAuditEventAsync ({
        requestId,
        requestInfo,
        resourceType,
        operation,
        resourceIds,
        tenantId,
        tenantName,
        correlationId,
        workflowStage,
        parentCorrelationId,
        x12TransactionId,
        x12TraceNumber,
        payerId,
        outcome,
        outcomeDesc,
        periodStart,
        periodEnd
    }) {
        // Skip auditing AuditEvent resources to prevent recursive loops
        if (resourceType === 'AuditEvent') {
            return;
        }

        this.postRequestProcessor.add({
            requestId,
            fnTask: async () => {
                try {
                    const auditEvent = this.createAuditEvent({
                        requestId,
                        requestInfo,
                        resourceType,
                        operation,
                        resourceIds,
                        tenantId,
                        tenantName,
                        correlationId,
                        workflowStage,
                        parentCorrelationId,
                        x12TransactionId,
                        x12TraceNumber,
                        payerId,
                        outcome,
                        outcomeDesc,
                        periodStart,
                        periodEnd
                    });

                    logInfo('Enhanced audit event created', {
                        auditEventId: auditEvent.id,
                        correlationId: correlationId || auditEvent.extension?.[0]?.extension?.[0]?.valueString,
                        operation,
                        resourceType,
                        tenantId,
                        workflowStage
                    });

                    return auditEvent;
                } catch (err) {
                    logError('Failed to create enhanced audit event', {
                        error: err,
                        operation,
                        resourceType,
                        tenantId,
                        requestId
                    });
                }
            }
        });
    }

    /**
     * Create an audit event for a prior authorization submission ($submit).
     *
     * Convenience method that pre-fills fields relevant to PAS operations
     * per CMS-0057-F requirements.
     *
     * @param {Object} params
     * @param {string} params.requestId - Unique request identifier
     * @param {Object} params.requestInfo - FHIR request info
     * @param {string} params.claimId - The Claim resource ID being submitted
     * @param {string} params.tenantId - Tenant identifier
     * @param {string} [params.tenantName] - Tenant display name
     * @param {string} params.correlationId - Correlation ID
     * @param {string} params.payerId - Payer identifier
     * @param {string} [params.x12TransactionId] - X12 278 transaction control number
     * @param {string} [params.x12TraceNumber] - X12 TRN trace number
     * @param {string} [params.outcome] - Outcome code
     * @param {string} [params.outcomeDesc] - Outcome description
     * @returns {Object} FHIR R4 AuditEvent resource JSON
     */
    createPriorAuthSubmitAuditEvent ({
        requestId,
        requestInfo,
        claimId,
        tenantId,
        tenantName,
        correlationId,
        payerId,
        x12TransactionId,
        x12TraceNumber,
        outcome,
        outcomeDesc
    }) {
        return this.createAuditEvent({
            requestId,
            requestInfo,
            resourceType: 'Claim',
            operation: '$submit',
            resourceIds: claimId ? [claimId] : [],
            tenantId,
            tenantName,
            correlationId,
            workflowStage: 'PAS-submit',
            payerId,
            x12TransactionId,
            x12TraceNumber,
            outcome,
            outcomeDesc,
            periodStart: new Date()
        });
    }

    /**
     * Create an audit event for a prior authorization inquiry ($inquire).
     *
     * @param {Object} params
     * @param {string} params.requestId - Unique request identifier
     * @param {Object} params.requestInfo - FHIR request info
     * @param {string} params.claimResponseId - The ClaimResponse resource ID
     * @param {string} params.tenantId - Tenant identifier
     * @param {string} [params.tenantName] - Tenant display name
     * @param {string} params.correlationId - Correlation ID
     * @param {string} params.payerId - Payer identifier
     * @param {string} [params.outcome] - Outcome code
     * @param {string} [params.outcomeDesc] - Outcome description
     * @returns {Object} FHIR R4 AuditEvent resource JSON
     */
    createPriorAuthInquireAuditEvent ({
        requestId,
        requestInfo,
        claimResponseId,
        tenantId,
        tenantName,
        correlationId,
        payerId,
        outcome,
        outcomeDesc
    }) {
        return this.createAuditEvent({
            requestId,
            requestInfo,
            resourceType: 'ClaimResponse',
            operation: '$inquire',
            resourceIds: claimResponseId ? [claimResponseId] : [],
            tenantId,
            tenantName,
            correlationId,
            workflowStage: 'PAS-inquire',
            payerId,
            outcome,
            outcomeDesc,
            periodStart: new Date()
        });
    }

    /**
     * Create an audit event for tenant lifecycle actions (creation, activation, suspension).
     *
     * @param {Object} params
     * @param {string} params.requestId - Unique request identifier
     * @param {string} params.tenantId - Tenant identifier
     * @param {string} [params.tenantName] - Tenant display name
     * @param {string} params.action - Lifecycle action ('create', 'activate', 'suspend', 'update')
     * @param {string} params.performedBy - Identity of the admin who performed the action
     * @param {string} [params.outcome] - Outcome code
     * @param {string} [params.outcomeDesc] - Outcome description
     * @returns {Object} FHIR R4 AuditEvent resource JSON
     */
    createTenantLifecycleAuditEvent ({
        requestId,
        tenantId,
        tenantName,
        action,
        performedBy,
        outcome,
        outcomeDesc
    }) {
        const actionCodeMap = {
            create: AUDIT_ACTION_CODES.CREATE,
            activate: AUDIT_ACTION_CODES.UPDATE,
            suspend: AUDIT_ACTION_CODES.UPDATE,
            update: AUDIT_ACTION_CODES.UPDATE
        };

        const builder = new AuditEventBuilder();

        builder
            .withType(AUDIT_TYPE_CODES.APPLICATION_ACTIVITY)
            .withSubtype([{
                system: 'https://fhir.icanbwell.com/CodeSystem/tenant-lifecycle',
                code: action,
                display: `Tenant ${action}`
            }])
            .withAction(actionCodeMap[action] || AUDIT_ACTION_CODES.EXECUTE)
            .withRecorded(new Date())
            .withOutcome(outcome || AUDIT_OUTCOME_CODES.SUCCESS, outcomeDesc)
            .withAgent({
                who: `Practitioner/${performedBy}`,
                requestor: true,
                name: performedBy
            })
            .withAgent({
                who: 'Device/fhir-platform',
                requestor: false,
                name: 'FHIR Prior Authorization Platform'
            })
            .withSource({
                site: tenantName || tenantId || 'platform',
                observer: 'Device/fhir-platform',
                type: [AUDIT_SOURCE_TYPE_CODES.APPLICATION_SERVER]
            })
            .withEntity({
                what: `Organization/${tenantId}`,
                type: AUDIT_ENTITY_TYPE_CODES.SYSTEM_OBJECT,
                role: AUDIT_ENTITY_ROLE_CODES.DOMAIN_RESOURCE,
                name: tenantName || tenantId,
                detail: [
                    { type: 'tenantId', valueString: tenantId },
                    { type: 'action', valueString: action },
                    { type: 'requestId', valueString: requestId }
                ]
            })
            .withCorrelation({
                correlationId: requestId,
                workflowStage: 'tenant-lifecycle'
            });

        if (tenantId) {
            builder.withTenant({ tenantId, tenantName });
        }

        return builder.build();
    }

    /**
     * Resolve the DICOM/FHIR event type based on the operation and resource type.
     *
     * @param {string} operation - FHIR operation name
     * @param {string} resourceType - FHIR resource type
     * @returns {Object} Type coding object with system, code, display
     * @private
     */
    _resolveEventType (operation, resourceType) {
        // Patient-related operations get a Patient Record event type
        const patientResources = ['Patient', 'Person', 'RelatedPerson'];
        if (patientResources.includes(resourceType)) {
            return AUDIT_TYPE_CODES.PATIENT_RECORD;
        }

        // Search and read operations are queries
        if (['search', 'read', 'vread', 'history', '$inquire'].includes(operation)) {
            return AUDIT_TYPE_CODES.QUERY;
        }

        // Prior auth and order-related resources
        const orderResources = ['Claim', 'ClaimResponse', 'CoverageEligibilityRequest', 'CoverageEligibilityResponse'];
        if (orderResources.includes(resourceType)) {
            return AUDIT_TYPE_CODES.ORDER_RECORD;
        }

        // Default to REST type for general FHIR interactions
        return AUDIT_TYPE_CODES.REST;
    }

    /**
     * Resolve the actor reference from request info.
     *
     * @param {Object} requestInfo - FHIR request info
     * @param {string} requestInfo.user - User identity
     * @param {boolean} [requestInfo.isUser] - Whether this is a human user
     * @returns {string} FHIR reference string
     * @private
     */
    _resolveActorReference (requestInfo) {
        if (!requestInfo || !requestInfo.user) {
            return 'Device/unknown';
        }

        if (requestInfo.isUser) {
            return `Practitioner/${requestInfo.user}`;
        }

        // System / service account
        return `Device/${requestInfo.user}`;
    }

    /**
     * Build entity detail array from audit context parameters.
     *
     * @param {Object} params
     * @param {string} params.correlationId
     * @param {string} params.workflowStage
     * @param {string} [params.tenantId]
     * @param {string} [params.payerId]
     * @param {string} [params.x12TransactionId]
     * @param {string} [params.x12TraceNumber]
     * @returns {Array<{type: string, valueString: string}>}
     * @private
     */
    _buildEntityDetails ({ correlationId, workflowStage, tenantId, payerId, x12TransactionId, x12TraceNumber }) {
        const details = [];

        if (correlationId) {
            details.push({ type: 'correlationId', valueString: correlationId });
        }
        if (workflowStage) {
            details.push({ type: 'workflow', valueString: workflowStage });
        }
        if (tenantId) {
            details.push({ type: 'tenantId', valueString: tenantId });
        }
        if (payerId) {
            details.push({ type: 'payerId', valueString: payerId });
        }
        if (x12TransactionId) {
            details.push({ type: 'x12TransactionId', valueString: x12TransactionId });
        }
        if (x12TraceNumber) {
            details.push({ type: 'x12TraceNumber', valueString: x12TraceNumber });
        }

        return details;
    }
}

module.exports = {
    EnhancedAuditLogger
};
