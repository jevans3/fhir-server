/**
 * CorrelationIdManager - Generates, propagates, and resolves correlation IDs
 * for end-to-end tracing of prior authorization workflows.
 *
 * Correlation ID flow:
 *   CRD (hook call) -> DTR (questionnaire) -> PAS ($submit) -> CDex ($submit-attachment)
 *
 * Each stage inherits the correlation ID from the previous stage,
 * creating a full audit trail for the entire PA workflow.
 */
const httpContext = require('express-http-context');
const { generateUUID } = require('../utils/uid.util');

const CORRELATION_ID_HEADER = 'x-correlation-id';
const WORKFLOW_STAGE_HEADER = 'x-workflow-stage';

/**
 * Da Vinci workflow stages for prior authorization
 */
const WORKFLOW_STAGES = {
    CRD: 'CRD',
    DTR: 'DTR',
    PAS_SUBMIT: 'PAS-submit',
    PAS_INQUIRE: 'PAS-inquire',
    PAS_UPDATE: 'PAS-update',
    PAS_CANCEL: 'PAS-cancel',
    CDEX_SUBMIT_ATTACHMENT: 'CDex-submit-attachment',
    CDEX_TASK_EXCHANGE: 'CDex-task-exchange',
    PROVIDER_ACCESS: 'Provider-Access',
    FHIR_OPERATION: 'FHIR-operation'
};

class CorrelationIdManager {
    constructor () {
        /**
         * In-memory correlation chain tracker
         * Maps correlationId -> { stages, startTime, tenantId, patientId }
         * @type {Map<string, Object>}
         */
        this.activeCorrelations = new Map();

        /**
         * Max correlations to track in memory (LRU-like cleanup)
         * @type {number}
         */
        this.maxTracked = 10000;
    }

    /**
     * Extract or generate a correlation ID from the incoming request
     * @param {import('http').IncomingMessage} req
     * @returns {string} correlationId
     */
    extractOrGenerate (req) {
        return req.headers[CORRELATION_ID_HEADER] || generateUUID();
    }

    /**
     * Extract the workflow stage from the request
     * @param {import('http').IncomingMessage} req
     * @returns {string|null}
     */
    extractWorkflowStage (req) {
        return req.headers[WORKFLOW_STAGE_HEADER] || null;
    }

    /**
     * Create a tracing context for the current request
     * @param {Object} params
     * @param {string} params.correlationId
     * @param {string} params.requestId
     * @param {string} [params.tenantId]
     * @param {string} [params.workflowStage]
     * @param {string} [params.patientId]
     * @param {string} [params.practitionerId]
     * @param {string} [params.payerId]
     * @returns {Object} tracingContext
     */
    createTracingContext ({
        correlationId,
        requestId,
        tenantId,
        workflowStage,
        patientId,
        practitionerId,
        payerId
    }) {
        const context = {
            correlationId,
            requestId,
            tenantId: tenantId || null,
            workflowStage: workflowStage || WORKFLOW_STAGES.FHIR_OPERATION,
            patientId: patientId || null,
            practitionerId: practitionerId || null,
            payerId: payerId || null,
            timestamp: new Date().toISOString()
        };

        // Track the correlation chain
        this.trackCorrelation(context);

        return context;
    }

    /**
     * Track a correlation for workflow tracing
     * @param {Object} context
     */
    trackCorrelation (context) {
        if (this.activeCorrelations.size >= this.maxTracked) {
            // Remove oldest entries
            const oldestKeys = Array.from(this.activeCorrelations.keys()).slice(0, 100);
            oldestKeys.forEach(k => this.activeCorrelations.delete(k));
        }

        const existing = this.activeCorrelations.get(context.correlationId);
        if (existing) {
            existing.stages.push({
                stage: context.workflowStage,
                requestId: context.requestId,
                timestamp: context.timestamp
            });
            existing.lastActivity = context.timestamp;
        } else {
            this.activeCorrelations.set(context.correlationId, {
                correlationId: context.correlationId,
                tenantId: context.tenantId,
                patientId: context.patientId,
                startTime: context.timestamp,
                lastActivity: context.timestamp,
                stages: [{
                    stage: context.workflowStage,
                    requestId: context.requestId,
                    timestamp: context.timestamp
                }]
            });
        }
    }

    /**
     * Get the correlation chain for a given correlation ID
     * @param {string} correlationId
     * @returns {Object|null}
     */
    getCorrelationChain (correlationId) {
        return this.activeCorrelations.get(correlationId) || null;
    }

    /**
     * Build HTTP headers to propagate correlation context to downstream services
     * @param {Object} tracingContext
     * @returns {Object} headers
     */
    buildPropagationHeaders (tracingContext) {
        const headers = {
            [CORRELATION_ID_HEADER]: tracingContext.correlationId
        };

        if (tracingContext.workflowStage) {
            headers[WORKFLOW_STAGE_HEADER] = tracingContext.workflowStage;
        }

        return headers;
    }

    /**
     * Get the current tracing context from httpContext
     * @returns {Object|null}
     */
    getCurrentContext () {
        return httpContext.get('tracingContext') || null;
    }

    /**
     * Store tracing context in httpContext for the current request
     * @param {Object} tracingContext
     */
    setCurrentContext (tracingContext) {
        httpContext.set('tracingContext', tracingContext);
    }

    /**
     * Create AuditEvent entity detail entries from tracing context
     * @param {Object} tracingContext
     * @returns {Array<{type: string, valueString: string}>}
     */
    toAuditEventDetails (tracingContext) {
        const details = [
            { type: 'correlationId', valueString: tracingContext.correlationId },
            { type: 'requestId', valueString: tracingContext.requestId },
            { type: 'workflow', valueString: tracingContext.workflowStage }
        ];

        if (tracingContext.tenantId) {
            details.push({ type: 'tenantId', valueString: tracingContext.tenantId });
        }
        if (tracingContext.payerId) {
            details.push({ type: 'payerId', valueString: tracingContext.payerId });
        }

        return details;
    }
}

module.exports = {
    CorrelationIdManager,
    CORRELATION_ID_HEADER,
    WORKFLOW_STAGE_HEADER,
    WORKFLOW_STAGES
};
