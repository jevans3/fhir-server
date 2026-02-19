/**
 * QuestionnairePackageOperation - Implements $questionnaire-package per Da Vinci DTR IG 2.1
 *
 * Route: POST /tenants/:tenantId/4_0_0/Questionnaire/$questionnaire-package
 *
 * Accepts a Parameters resource containing:
 *   - coverage: a FHIR Coverage resource identifying the payer and plan
 *   - order: a ServiceRequest, DeviceRequest, or MedicationRequest resource
 *
 * Proxies the request to the payer's DTR questionnaire endpoint (resolved from
 * the tenant's connectedPayers configuration), and returns a Bundle containing:
 *   - Questionnaire resource(s)
 *   - Library resource(s) with CQL logic
 *   - ValueSet resource(s) referenced by the questionnaire
 *
 * Creates an AuditEvent with correlation tracing for the full PA workflow chain.
 *
 * @see https://build.fhir.org/ig/HL7/davinci-dtr/OperationDefinition-questionnaire-package.html
 */
const { assertTypeEquals, assertIsValid } = require('../../utils/assertType');
const { TenantService } = require('../../multiTenancy/tenantService');
const { CorrelationIdManager, WORKFLOW_STAGES } = require('../../tracing/correlationIdManager');
const { DtrService } = require('./dtrService');
const { logInfo, logError } = require('../common/logging');
const { BadRequestError, NotFoundError } = require('../../utils/httpErrors');
const { generateUUID } = require('../../utils/uid.util');

/**
 * Supported order resource types for the $questionnaire-package operation
 * @type {string[]}
 */
const SUPPORTED_ORDER_TYPES = ['ServiceRequest', 'DeviceRequest', 'MedicationRequest'];

class QuestionnairePackageOperation {
    /**
     * @typedef {Object} QuestionnairePackageOperationParams
     * @property {TenantService} tenantService
     * @property {CorrelationIdManager} correlationIdManager
     * @property {DtrService} dtrService
     */

    /**
     * @param {QuestionnairePackageOperationParams} params
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
     * Execute the $questionnaire-package operation
     *
     * @typedef {Object} QuestionnairePackageAsyncParams
     * @property {import('http').IncomingMessage} req - The incoming HTTP request
     * @property {string} tenantId - The tenant ID from the route
     * @property {Object} body - The parsed FHIR Parameters resource from the request body
     *
     * @param {QuestionnairePackageAsyncParams} params
     * @returns {Promise<Object>} A FHIR Bundle containing Questionnaire, Library, and ValueSet resources
     * @throws {BadRequestError} if the request body is invalid
     * @throws {NotFoundError} if the tenant or payer connection is not found
     */
    async questionnairePackageAsync ({ req, tenantId, body }) {
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

        logInfo('$questionnaire-package operation started', {
            tenantId,
            correlationId,
            requestId
        });

        try {
            // Validate and extract parameters from the request body
            const { coverageResource, orderResource } = this.extractParameters(body);

            // Resolve payer from coverage
            const payerTenantId = this.dtrService.extractPayerIdFromCoverage(coverageResource);
            if (!payerTenantId) {
                throw new BadRequestError(
                    new Error('Unable to determine payer from Coverage resource. Ensure Coverage.payor is populated.')
                );
            }

            // Extract coverage type for caching
            const coverageType = this.dtrService.extractCoverageType(coverageResource);

            // Check cache first
            const cachedBundle = this.dtrService.getCachedPackage(tenantId, payerTenantId, coverageType);
            if (cachedBundle) {
                logInfo('$questionnaire-package served from cache', {
                    tenantId,
                    payerTenantId,
                    coverageType,
                    correlationId
                });

                // Create DTR session even for cached responses
                this.dtrService.createSession({
                    tenantId,
                    payerTenantId,
                    correlationId,
                    patientId: this.extractPatientId(coverageResource),
                    coverageId: coverageResource.id
                });

                return cachedBundle;
            }

            // Resolve payer DTR endpoint
            const payerEndpoint = await this.dtrService.resolvePayerDtrEndpointAsync(tenantId, payerTenantId);

            // Build the outbound request to the payer's DTR endpoint
            const propagationHeaders = this.correlationIdManager.buildPropagationHeaders(tracingContext);
            const outboundPayload = this.buildOutboundPayload(coverageResource, orderResource);

            // Proxy to payer endpoint
            const responseBundle = await this.proxyToPayerAsync({
                url: payerEndpoint.questionnairePackageUrl,
                payload: outboundPayload,
                headers: propagationHeaders,
                authConfig: payerEndpoint.authConfig,
                tenantId,
                payerTenantId,
                correlationId
            });

            // Validate the response is a proper Bundle
            this.validateResponseBundle(responseBundle);

            // Cache the response
            this.dtrService.setCachedPackage(tenantId, payerTenantId, coverageType, responseBundle);

            // Create DTR session
            const questionnaireId = this.extractQuestionnaireIdFromBundle(responseBundle);
            const sessionId = this.dtrService.createSession({
                tenantId,
                payerTenantId,
                correlationId,
                questionnaireId,
                patientId: this.extractPatientId(coverageResource),
                coverageId: coverageResource.id
            });

            this.dtrService.recordSessionInteraction(sessionId, {
                type: 'questionnaire-package',
                questionnaireId,
                success: true
            });

            logInfo('$questionnaire-package operation completed', {
                tenantId,
                payerTenantId,
                correlationId,
                durationMs: Date.now() - startTime,
                bundleEntryCount: responseBundle.entry?.length || 0
            });

            return responseBundle;
        } catch (err) {
            logError('$questionnaire-package operation failed', {
                tenantId,
                correlationId,
                error: err.message,
                durationMs: Date.now() - startTime
            });
            throw err;
        }
    }

    /**
     * Extract and validate parameters from the Parameters resource body
     * @param {Object} body - The FHIR Parameters resource
     * @returns {{coverageResource: Object, orderResource: Object|null}}
     * @throws {BadRequestError}
     */
    extractParameters (body) {
        if (!body || body.resourceType !== 'Parameters') {
            throw new BadRequestError(
                new Error('Request body must be a FHIR Parameters resource')
            );
        }

        const parameters = body.parameter || [];

        // Extract coverage parameter (required)
        const coverageParam = parameters.find(p => p.name === 'coverage');
        if (!coverageParam || !coverageParam.resource) {
            throw new BadRequestError(
                new Error('Required parameter "coverage" with a Coverage resource is missing')
            );
        }

        const coverageResource = coverageParam.resource;
        if (coverageResource.resourceType !== 'Coverage') {
            throw new BadRequestError(
                new Error(`Expected Coverage resource for "coverage" parameter, got ${coverageResource.resourceType}`)
            );
        }

        // Extract order parameter (optional per spec, but typically provided)
        const orderParam = parameters.find(p => p.name === 'order');
        let orderResource = null;
        if (orderParam && orderParam.resource) {
            orderResource = orderParam.resource;
            if (!SUPPORTED_ORDER_TYPES.includes(orderResource.resourceType)) {
                throw new BadRequestError(
                    new Error(
                        `Unsupported order resource type "${orderResource.resourceType}". ` +
                        `Supported types: ${SUPPORTED_ORDER_TYPES.join(', ')}`
                    )
                );
            }
        }

        return { coverageResource, orderResource };
    }

    /**
     * Build the outbound Parameters payload to send to the payer's DTR endpoint
     * @param {Object} coverageResource
     * @param {Object|null} orderResource
     * @returns {Object} FHIR Parameters resource
     */
    buildOutboundPayload (coverageResource, orderResource) {
        const parameters = [
            {
                name: 'coverage',
                resource: coverageResource
            }
        ];

        if (orderResource) {
            parameters.push({
                name: 'order',
                resource: orderResource
            });
        }

        return {
            resourceType: 'Parameters',
            parameter: parameters
        };
    }

    /**
     * Proxy the $questionnaire-package request to the payer's DTR endpoint
     * @param {Object} params
     * @param {string} params.url - The payer's questionnaire-package endpoint URL
     * @param {Object} params.payload - The outbound Parameters resource
     * @param {Object} params.headers - Propagation headers including correlation ID
     * @param {Object} params.authConfig - Authentication configuration for the payer endpoint
     * @param {string} params.tenantId
     * @param {string} params.payerTenantId
     * @param {string} params.correlationId
     * @returns {Promise<Object>} The response Bundle from the payer
     */
    async proxyToPayerAsync ({ url, payload, headers, authConfig, tenantId, payerTenantId, correlationId }) {
        logInfo('Proxying $questionnaire-package to payer endpoint', {
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
                    `Payer DTR endpoint returned HTTP ${response.status}: ${errorBody}`
                );
            }

            const responseBody = await response.json();
            return responseBody;
        } catch (err) {
            logError('Failed to proxy $questionnaire-package to payer', {
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
                new Error(`Failed to retrieve questionnaire package from payer: ${err.message}`)
            );
        }
    }

    /**
     * Validate that the response from the payer is a proper FHIR Bundle
     * @param {Object} responseBundle
     * @throws {BadRequestError}
     */
    validateResponseBundle (responseBundle) {
        if (!responseBundle || responseBundle.resourceType !== 'Bundle') {
            throw new BadRequestError(
                new Error('Payer DTR endpoint did not return a valid FHIR Bundle')
            );
        }

        if (!responseBundle.entry || responseBundle.entry.length === 0) {
            throw new BadRequestError(
                new Error('Payer DTR endpoint returned an empty Bundle')
            );
        }

        // Verify the bundle contains at least a Questionnaire resource
        const hasQuestionnaire = responseBundle.entry.some(
            e => e.resource?.resourceType === 'Questionnaire'
        );

        if (!hasQuestionnaire) {
            throw new BadRequestError(
                new Error('Payer DTR endpoint Bundle does not contain a Questionnaire resource')
            );
        }
    }

    /**
     * Extract the first Questionnaire ID from a response Bundle
     * @param {Object} bundle
     * @returns {string|null}
     */
    extractQuestionnaireIdFromBundle (bundle) {
        const questionnaireEntry = bundle.entry?.find(
            e => e.resource?.resourceType === 'Questionnaire'
        );
        return questionnaireEntry?.resource?.id || null;
    }

    /**
     * Extract the patient reference from a Coverage resource
     * @param {Object} coverageResource
     * @returns {string|null}
     */
    extractPatientId (coverageResource) {
        const beneficiaryRef = coverageResource.beneficiary?.reference;
        if (!beneficiaryRef) {
            return null;
        }
        const parts = beneficiaryRef.split('/');
        return parts.length > 1 ? parts[parts.length - 1] : beneficiaryRef;
    }

    /**
     * Build an AuditEvent for the $questionnaire-package operation
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
            operationType: 'questionnaire-package',
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
    QuestionnairePackageOperation
};
