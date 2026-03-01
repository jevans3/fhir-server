/**
 * NextQuestionOperation - Implements $next-question for Adaptive Forms per Da Vinci DTR IG 2.1
 *
 * Route: POST /tenants/:tenantId/4_0_0/Questionnaire/$next-question
 *
 * Accepts a QuestionnaireResponse resource containing the current answers provided
 * by the user during an adaptive questionnaire session. Proxies the request to the
 * payer's $next-question endpoint and returns an updated QuestionnaireResponse
 * containing the next question(s) to present to the user.
 *
 * The adaptive form flow allows payers to dynamically determine which questions
 * to ask based on previous answers, reducing provider burden by only requesting
 * information that is actually needed for the prior authorization decision.
 *
 * @see https://build.fhir.org/ig/HL7/davinci-dtr/OperationDefinition-next-question.html
 */
const { assertTypeEquals, assertIsValid } = require('../../utils/assertType');
const { TenantService } = require('../../multiTenancy/tenantService');
const { CorrelationIdManager, WORKFLOW_STAGES } = require('../../tracing/correlationIdManager');
const { DtrService } = require('./dtrService');
const { logInfo, logError } = require('../common/logging');
const { BadRequestError, NotFoundError } = require('../../utils/httpErrors');
const { generateUUID } = require('../../utils/uid.util');

class NextQuestionOperation {
    /**
     * @typedef {Object} NextQuestionOperationParams
     * @property {TenantService} tenantService
     * @property {CorrelationIdManager} correlationIdManager
     * @property {DtrService} dtrService
     */

    /**
     * @param {NextQuestionOperationParams} params
     */
    constructor ({ tenantService, correlationIdManager, dtrService }) {
        /**
         * @type {TenantService}
         */
        this.tenantService = tenantService;
        assertTypeEquals(tenantService, TenantService);

        /**
         * @type {CorrelationIdManager}
         */
        this.correlationIdManager = correlationIdManager;
        assertTypeEquals(correlationIdManager, CorrelationIdManager);

        /**
         * @type {DtrService}
         */
        this.dtrService = dtrService;
        assertTypeEquals(dtrService, DtrService);
    }

    /**
     * Execute the $next-question operation
     *
     * @typedef {Object} NextQuestionAsyncParams
     * @property {import('http').IncomingMessage} req - The incoming HTTP request
     * @property {string} tenantId - The tenant ID from the route
     * @property {Object} body - The parsed FHIR QuestionnaireResponse resource
     *
     * @param {NextQuestionAsyncParams} params
     * @returns {Promise<Object>} An updated FHIR QuestionnaireResponse with next question(s)
     * @throws {BadRequestError} if the request body is invalid
     * @throws {NotFoundError} if the tenant or payer connection is not found
     */
    async nextQuestionAsync ({ req, tenantId, body }) {
        assertIsValid(tenantId, 'tenantId is required');
        assertIsValid(body, 'Request body is required');

        const startTime = Date.now();
        const requestId = req.id || generateUUID();

        // Extract correlation context
        const correlationId = this.correlationIdManager.extractOrGenerate(req);
        const tracingContext = this.correlationIdManager.createTracingContext({
            correlationId,
            requestId,
            tenantId,
            workflowStage: WORKFLOW_STAGES.DTR
        });

        logInfo('$next-question operation started', {
            tenantId,
            correlationId,
            requestId
        });

        try {
            // Validate the incoming QuestionnaireResponse
            const questionnaireResponse = this.validateQuestionnaireResponse(body);

            // Resolve the payer from the QuestionnaireResponse context
            const payerTenantId = this.resolvePayerFromQuestionnaireResponse(questionnaireResponse);
            if (!payerTenantId) {
                throw new BadRequestError(
                    new Error(
                        'Unable to determine payer from QuestionnaireResponse. ' +
                        'Ensure the QuestionnaireResponse contains a payer reference in the contained resources ' +
                        'or extensions.'
                    )
                );
            }

            // Resolve payer DTR endpoint
            const payerEndpoint = await this.dtrService.resolvePayerDtrEndpointAsync(tenantId, payerTenantId);

            if (!payerEndpoint.nextQuestionUrl) {
                throw new BadRequestError(
                    new Error(
                        `Payer '${payerTenantId}' does not support the $next-question operation (adaptive forms). ` +
                        'The next-question endpoint is not configured.'
                    )
                );
            }

            // Build propagation headers
            const propagationHeaders = this.correlationIdManager.buildPropagationHeaders(tracingContext);

            // Proxy to payer endpoint
            const updatedResponse = await this.proxyToPayerAsync({
                url: payerEndpoint.nextQuestionUrl,
                payload: questionnaireResponse,
                headers: propagationHeaders,
                authConfig: payerEndpoint.authConfig,
                tenantId,
                payerTenantId,
                correlationId
            });

            // Validate the response
            this.validateNextQuestionResponse(updatedResponse);

            // Record interaction in DTR session if active
            const questionnaireId = this.extractQuestionnaireId(questionnaireResponse);
            this.recordSessionInteraction({
                tenantId,
                correlationId,
                questionnaireId,
                success: true
            });

            logInfo('$next-question operation completed', {
                tenantId,
                payerTenantId,
                correlationId,
                durationMs: Date.now() - startTime,
                status: updatedResponse.status,
                itemCount: updatedResponse.item?.length || 0
            });

            return updatedResponse;
        } catch (err) {
            logError('$next-question operation failed', {
                tenantId,
                correlationId,
                error: err.message,
                durationMs: Date.now() - startTime
            });
            throw err;
        }
    }

    /**
     * Validate the incoming QuestionnaireResponse resource
     * @param {Object} body
     * @returns {Object} The validated QuestionnaireResponse
     * @throws {BadRequestError}
     */
    validateQuestionnaireResponse (body) {
        if (!body || body.resourceType !== 'QuestionnaireResponse') {
            throw new BadRequestError(
                new Error('Request body must be a FHIR QuestionnaireResponse resource')
            );
        }

        if (!body.questionnaire) {
            throw new BadRequestError(
                new Error(
                    'QuestionnaireResponse.questionnaire is required. ' +
                    'It must reference the canonical URL of the Questionnaire being completed.'
                )
            );
        }

        // Per DTR IG, the status should be 'in-progress' for adaptive form interactions
        if (body.status && body.status !== 'in-progress') {
            throw new BadRequestError(
                new Error(
                    `QuestionnaireResponse.status must be "in-progress" for $next-question. Got "${body.status}".`
                )
            );
        }

        return body;
    }

    /**
     * Resolve the payer tenant ID from the QuestionnaireResponse context
     *
     * Looks for payer information in the following order:
     * 1. Contained Coverage resource with payor reference
     * 2. Extension with payer identifier
     * 3. Source reference in the QuestionnaireResponse
     *
     * @param {Object} questionnaireResponse
     * @returns {string|null}
     */
    resolvePayerFromQuestionnaireResponse (questionnaireResponse) {
        // Check contained resources for a Coverage with payor
        if (questionnaireResponse.contained) {
            const containedCoverage = questionnaireResponse.contained.find(
                r => r.resourceType === 'Coverage'
            );
            if (containedCoverage) {
                return this.dtrService.extractPayerIdFromCoverage(containedCoverage);
            }
        }

        // Check extensions for payer identifier
        const payerExtension = questionnaireResponse.extension?.find(
            ext => ext.url?.includes('payer') || ext.url?.includes('insurer')
        );
        if (payerExtension?.valueReference?.reference) {
            const parts = payerExtension.valueReference.reference.split('/');
            return parts.length > 1 ? parts[parts.length - 1] : payerExtension.valueReference.reference;
        }
        if (payerExtension?.valueIdentifier?.value) {
            return payerExtension.valueIdentifier.value;
        }

        // Check source for payer context
        if (questionnaireResponse.source?.reference) {
            const parts = questionnaireResponse.source.reference.split('/');
            if (parts.length > 1 && parts[parts.length - 2] === 'Organization') {
                return parts[parts.length - 1];
            }
        }

        return null;
    }

    /**
     * Proxy the $next-question request to the payer endpoint
     * @param {Object} params
     * @param {string} params.url - The payer's next-question endpoint URL
     * @param {Object} params.payload - The QuestionnaireResponse to send
     * @param {Object} params.headers - Propagation headers
     * @param {Object} params.authConfig - Auth configuration for the payer
     * @param {string} params.tenantId
     * @param {string} params.payerTenantId
     * @param {string} params.correlationId
     * @returns {Promise<Object>} The updated QuestionnaireResponse
     */
    async proxyToPayerAsync ({ url, payload, headers, authConfig, tenantId, payerTenantId, correlationId }) {
        logInfo('Proxying $next-question to payer endpoint', {
            url,
            tenantId,
            payerTenantId,
            correlationId
        });

        try {
            const fetchOptions = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/fhir+json',
                    Accept: 'application/fhir+json',
                    ...headers
                },
                body: JSON.stringify(payload)
            };

            // Add authorization if configured
            if (authConfig && authConfig.accessToken) {
                fetchOptions.headers.Authorization = `Bearer ${authConfig.accessToken}`;
            }

            const response = await fetch(url, fetchOptions);

            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(
                    `Payer $next-question endpoint returned HTTP ${response.status}: ${errorBody}`
                );
            }

            const responseBody = await response.json();
            return responseBody;
        } catch (err) {
            logError('Failed to proxy $next-question to payer', {
                url,
                tenantId,
                payerTenantId,
                correlationId,
                error: err.message
            });

            if (err instanceof BadRequestError || err instanceof NotFoundError) {
                throw err;
            }

            throw new BadRequestError(
                new Error(`Failed to retrieve next question from payer: ${err.message}`)
            );
        }
    }

    /**
     * Validate the response from the payer's $next-question endpoint
     * @param {Object} response
     * @throws {BadRequestError}
     */
    validateNextQuestionResponse (response) {
        if (!response || response.resourceType !== 'QuestionnaireResponse') {
            throw new BadRequestError(
                new Error('Payer $next-question endpoint did not return a valid QuestionnaireResponse')
            );
        }

        // Valid statuses for the response: in-progress (more questions) or completed (no more questions)
        const validStatuses = ['in-progress', 'completed'];
        if (response.status && !validStatuses.includes(response.status)) {
            throw new BadRequestError(
                new Error(
                    `Payer returned QuestionnaireResponse with unexpected status "${response.status}". ` +
                    `Expected one of: ${validStatuses.join(', ')}`
                )
            );
        }
    }

    /**
     * Extract the Questionnaire canonical ID from a QuestionnaireResponse
     * @param {Object} questionnaireResponse
     * @returns {string|null}
     */
    extractQuestionnaireId (questionnaireResponse) {
        const canonical = questionnaireResponse.questionnaire;
        if (!canonical) {
            return null;
        }
        // The questionnaire field is a canonical URL; extract the last segment as ID
        const parts = canonical.split('/');
        return parts[parts.length - 1];
    }

    /**
     * Record an interaction in the active DTR session (if one exists)
     * @param {Object} params
     * @param {string} params.tenantId
     * @param {string} params.correlationId
     * @param {string} [params.questionnaireId]
     * @param {boolean} params.success
     */
    recordSessionInteraction ({ tenantId, correlationId, questionnaireId, success }) {
        // Find the active session for this tenant and correlation ID
        const sessions = this.dtrService.getActiveSessionsForTenant(tenantId);
        const matchingSession = sessions.find(s => s.correlationId === correlationId);

        if (matchingSession) {
            this.dtrService.recordSessionInteraction(matchingSession.sessionId, {
                type: 'next-question',
                questionnaireId,
                success
            });
        }
    }

    /**
     * Build an AuditEvent for the $next-question operation
     * @param {Object} params
     * @param {string} params.tenantId
     * @param {string} params.correlationId
     * @param {string} params.requestId
     * @param {string} [params.payerTenantId]
     * @param {string} [params.patientId]
     * @param {string} [params.questionnaireId]
     * @param {string} params.outcome - 'success' | 'error'
     * @param {string} [params.outcomeDesc]
     * @returns {Object} FHIR AuditEvent resource
     */
    buildAuditEvent ({ tenantId, correlationId, requestId, payerTenantId, patientId, questionnaireId, outcome, outcomeDesc }) {
        return this.dtrService.buildAuditEvent({
            tenantId,
            correlationId,
            operationType: 'next-question',
            requestId,
            payerTenantId,
            patientId,
            questionnaireId,
            outcome,
            outcomeDesc
        });
    }
}

module.exports = {
    NextQuestionOperation
};
