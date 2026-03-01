/**
 * SubmitAttachmentOperation - Implements $submit-attachment per Da Vinci CDex IG 2.1
 *
 * Route: POST /tenants/:tenantId/4_0_0/$submit-attachment
 *
 * Accepts a Parameters resource containing:
 *   - TrackingId: Unique tracking identifier for the attachment submission
 *   - PayerId: Identifier of the target payer organization
 *   - OrganizationId: Identifier of the submitting provider organization
 *   - ProviderId: Identifier of the submitting provider (alternative to OrganizationId)
 *   - Attachment: One or more attachment parameter groups, each containing:
 *     - Content: A DocumentReference resource with the attachment content
 *     - LineItem: Claim line item identifier (optional)
 *     - Code: Attachment code identifying what the attachment is for
 *   - Final: Boolean indicating if this is the final attachment submission
 *
 * Routes the attachment to the correct payer endpoint based on PayerId and tenant
 * configuration. Returns HTTP 200 with no output parameters per the CDex specification,
 * or appropriate error codes.
 *
 * Creates an AuditEvent with correlation tracing and attachment metadata for the
 * full PA workflow chain.
 *
 * @see https://build.fhir.org/ig/HL7/davinci-cdex/OperationDefinition-submit-attachment.html
 */
const { assertTypeEquals, assertIsValid } = require('../../utils/assertType');
const { TenantService } = require('../../multiTenancy/tenantService');
const { CorrelationIdManager, WORKFLOW_STAGES } = require('../../tracing/correlationIdManager');
const { logInfo, logError } = require('../common/logging');
const { BadRequestError, NotFoundError } = require('../../utils/httpErrors');
const { generateUUID } = require('../../utils/uid.util');

class SubmitAttachmentOperation {
    /**
     * @typedef {Object} SubmitAttachmentOperationParams
     * @property {TenantService} tenantService
     * @property {CorrelationIdManager} correlationIdManager
     */

    /**
     * @param {SubmitAttachmentOperationParams} params
     */
    constructor ({ tenantService, correlationIdManager }) {
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
    }

    /**
     * Execute the $submit-attachment operation
     *
     * @typedef {Object} SubmitAttachmentAsyncParams
     * @property {import('http').IncomingMessage} req - The incoming HTTP request
     * @property {string} tenantId - The tenant ID from the route
     * @property {Object} body - The parsed FHIR Parameters resource from the request body
     *
     * @param {SubmitAttachmentAsyncParams} params
     * @returns {Promise<void>} Returns void (HTTP 200 with no body per CDex spec)
     * @throws {BadRequestError} if the request body is invalid
     * @throws {NotFoundError} if the tenant or payer connection is not found
     */
    async submitAttachmentAsync ({ req, tenantId, body }) {
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
            workflowStage: WORKFLOW_STAGES.CDEX_SUBMIT_ATTACHMENT
        });

        logInfo('$submit-attachment operation started', {
            tenantId,
            correlationId,
            requestId
        });

        try {
            // Validate and extract parameters
            const attachmentParams = this.extractParameters(body);

            // Resolve the payer endpoint
            const payerEndpoint = await this.resolvePayerEndpointAsync(
                tenantId,
                attachmentParams.payerId
            );

            // Build propagation headers
            const propagationHeaders = this.correlationIdManager.buildPropagationHeaders(tracingContext);

            // Proxy to payer endpoint
            await this.proxyToPayerAsync({
                url: payerEndpoint.submitAttachmentUrl,
                payload: body,
                headers: propagationHeaders,
                authConfig: payerEndpoint.authConfig,
                tenantId,
                payerId: attachmentParams.payerId,
                correlationId
            });

            logInfo('$submit-attachment operation completed', {
                tenantId,
                payerId: attachmentParams.payerId,
                trackingId: attachmentParams.trackingId,
                correlationId,
                attachmentCount: attachmentParams.attachments.length,
                isFinal: attachmentParams.isFinal,
                durationMs: Date.now() - startTime
            });

            // Return void per CDex spec (HTTP 200 with no output parameters)
            return undefined;
        } catch (err) {
            logError('$submit-attachment operation failed', {
                tenantId,
                correlationId,
                error: err.message,
                durationMs: Date.now() - startTime
            });
            throw err;
        }
    }

    /**
     * Extract and validate parameters from the Parameters resource
     * @param {Object} body
     * @returns {{trackingId: string, payerId: string, organizationId: string|null, providerId: string|null, attachments: Object[], isFinal: boolean}}
     * @throws {BadRequestError}
     */
    extractParameters (body) {
        if (!body || body.resourceType !== 'Parameters') {
            throw new BadRequestError(
                new Error('Request body must be a FHIR Parameters resource')
            );
        }

        const parameters = body.parameter || [];

        // Extract TrackingId (required)
        const trackingIdParam = parameters.find(p => p.name === 'TrackingId');
        if (!trackingIdParam || !trackingIdParam.valueString) {
            throw new BadRequestError(
                new Error('Required parameter "TrackingId" is missing or has no valueString')
            );
        }
        const trackingId = trackingIdParam.valueString;

        // Extract PayerId (required)
        const payerIdParam = parameters.find(p => p.name === 'PayerId');
        if (!payerIdParam || !payerIdParam.valueIdentifier) {
            throw new BadRequestError(
                new Error('Required parameter "PayerId" is missing or has no valueIdentifier')
            );
        }
        const payerId = payerIdParam.valueIdentifier.value;
        if (!payerId) {
            throw new BadRequestError(
                new Error('PayerId valueIdentifier.value is required')
            );
        }

        // Extract OrganizationId (conditionally required with ProviderId)
        const orgIdParam = parameters.find(p => p.name === 'OrganizationId');
        const organizationId = orgIdParam?.valueIdentifier?.value || null;

        // Extract ProviderId (conditionally required with OrganizationId)
        const providerIdParam = parameters.find(p => p.name === 'ProviderId');
        const providerId = providerIdParam?.valueIdentifier?.value || null;

        if (!organizationId && !providerId) {
            throw new BadRequestError(
                new Error('At least one of "OrganizationId" or "ProviderId" is required')
            );
        }

        // Extract Attachment parameter groups (at least one required)
        const attachmentParams = parameters.filter(p => p.name === 'Attachment');
        if (attachmentParams.length === 0) {
            throw new BadRequestError(
                new Error('At least one "Attachment" parameter is required')
            );
        }

        const attachments = attachmentParams.map((attachmentParam, index) => {
            return this.extractAttachmentParts(attachmentParam, index);
        });

        // Extract Final flag (optional, defaults to true)
        const finalParam = parameters.find(p => p.name === 'Final');
        const isFinal = finalParam?.valueBoolean !== undefined ? finalParam.valueBoolean : true;

        return {
            trackingId,
            payerId,
            organizationId,
            providerId,
            attachments,
            isFinal
        };
    }

    /**
     * Extract the parts of an Attachment parameter group
     * @param {Object} attachmentParam - The Attachment parameter with nested parts
     * @param {number} index - The index of this attachment for error messages
     * @returns {{content: Object|null, lineItem: string|null, code: Object|null}}
     * @throws {BadRequestError}
     */
    extractAttachmentParts (attachmentParam, index) {
        const parts = attachmentParam.part || [];

        // Extract Content (DocumentReference resource)
        const contentPart = parts.find(p => p.name === 'Content');
        if (!contentPart || !contentPart.resource) {
            throw new BadRequestError(
                new Error(`Attachment[${index}].Content is required and must contain a resource`)
            );
        }
        const content = contentPart.resource;
        if (content.resourceType !== 'DocumentReference') {
            throw new BadRequestError(
                new Error(
                    `Attachment[${index}].Content must be a DocumentReference resource, ` +
                    `got ${content.resourceType}`
                )
            );
        }

        // Extract LineItem (optional)
        const lineItemPart = parts.find(p => p.name === 'LineItem');
        const lineItem = lineItemPart?.valueString || null;

        // Extract Code (optional but recommended)
        const codePart = parts.find(p => p.name === 'Code');
        const code = codePart?.valueCodeableConcept || codePart?.valueCoding || null;

        return {
            content,
            lineItem,
            code
        };
    }

    /**
     * Resolve the payer's $submit-attachment endpoint from tenant configuration
     * @param {string} tenantId - The provider tenant ID
     * @param {string} payerId - The payer identifier from the Parameters
     * @returns {Promise<{submitAttachmentUrl: string, authConfig: Object}>}
     * @throws {NotFoundError}
     * @throws {BadRequestError}
     */
    async resolvePayerEndpointAsync (tenantId, payerId) {
        const tenantContext = await this.tenantService.getTenantAsync(tenantId);

        if (!tenantContext) {
            throw new NotFoundError(`Tenant '${tenantId}' not found`);
        }

        if (!tenantContext.isFeatureEnabled('cdexEnabled')) {
            throw new BadRequestError(
                new Error(`CDex is not enabled for tenant '${tenantId}'`)
            );
        }

        // Find the payer connection - try matching by payerTenantId first, then by payerId
        let payerConnection = tenantContext.getPayerConnection(payerId);

        if (!payerConnection) {
            // Try finding by payer identifier in the connected payers list
            payerConnection = tenantContext.connectedPayers.find(
                p => p.payerOrganizationId === payerId || p.payerNpi === payerId
            );
        }

        if (!payerConnection) {
            throw new NotFoundError(
                `No payer connection found for payer '${payerId}' on tenant '${tenantId}'`
            );
        }

        const cdexEndpoints = payerConnection.cdexEndpoints || payerConnection.endpoints?.cdex;
        if (!cdexEndpoints || !cdexEndpoints.submitAttachmentUrl) {
            throw new BadRequestError(
                new Error(
                    `CDex $submit-attachment endpoint not configured for payer '${payerId}' on tenant '${tenantId}'`
                )
            );
        }

        return {
            submitAttachmentUrl: cdexEndpoints.submitAttachmentUrl,
            authConfig: payerConnection.authConfig || {}
        };
    }

    /**
     * Proxy the $submit-attachment request to the payer endpoint
     * @param {Object} params
     * @param {string} params.url - The payer's submit-attachment endpoint URL
     * @param {Object} params.payload - The Parameters resource to send
     * @param {Object} params.headers - Propagation headers including correlation ID
     * @param {Object} params.authConfig - Authentication configuration for the payer endpoint
     * @param {string} params.tenantId
     * @param {string} params.payerId
     * @param {string} params.correlationId
     * @returns {Promise<void>}
     */
    async proxyToPayerAsync ({ url, payload, headers, authConfig, tenantId, payerId, correlationId }) {
        logInfo('Proxying $submit-attachment to payer endpoint', {
            url,
            tenantId,
            payerId,
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
                    `Payer $submit-attachment endpoint returned HTTP ${response.status}: ${errorBody}`
                );
            }

            // Per CDex spec, successful response is HTTP 200 with no body
            // Some payers may return an OperationOutcome; we accept either
            return undefined;
        } catch (err) {
            logError('Failed to proxy $submit-attachment to payer', {
                url,
                tenantId,
                payerId,
                correlationId,
                error: err.message
            });

            if (err instanceof BadRequestError || err instanceof NotFoundError) {
                throw err;
            }

            throw new BadRequestError(
                new Error(`Failed to submit attachment to payer: ${err.message}`)
            );
        }
    }

    /**
     * Build an AuditEvent for the $submit-attachment operation
     * @param {Object} params
     * @param {string} params.tenantId
     * @param {string} params.correlationId
     * @param {string} params.requestId
     * @param {string} params.payerId
     * @param {string} [params.trackingId]
     * @param {string} [params.organizationId]
     * @param {string} [params.providerId]
     * @param {number} [params.attachmentCount]
     * @param {boolean} [params.isFinal]
     * @param {string} params.outcome - 'success' | 'error'
     * @param {string} [params.outcomeDesc]
     * @returns {Object} FHIR AuditEvent resource
     */
    buildAuditEvent ({
        tenantId,
        correlationId,
        requestId,
        payerId,
        trackingId,
        organizationId,
        providerId,
        attachmentCount,
        isFinal,
        outcome,
        outcomeDesc
    }) {
        const now = new Date().toISOString();
        return {
            resourceType: 'AuditEvent',
            type: {
                system: 'http://dicom.nema.org/resources/ontology/DCM',
                code: '110106',
                display: 'Export'
            },
            subtype: [
                {
                    system: 'http://hl7.org/fhir/us/davinci-cdex',
                    code: 'submit-attachment',
                    display: 'CDex Submit Attachment'
                }
            ],
            action: 'C',
            period: {
                start: now
            },
            recorded: now,
            outcome: outcome === 'success' ? '0' : '8',
            outcomeDesc: outcomeDesc || `CDex $submit-attachment ${outcome}`,
            agent: [
                {
                    type: {
                        coding: [
                            {
                                system: 'http://dicom.nema.org/resources/ontology/DCM',
                                code: '110153',
                                display: 'Source Role ID'
                            }
                        ]
                    },
                    who: {
                        display: `Tenant/${tenantId}`
                    },
                    requestor: true
                },
                {
                    type: {
                        coding: [
                            {
                                system: 'http://dicom.nema.org/resources/ontology/DCM',
                                code: '110152',
                                display: 'Destination Role ID'
                            }
                        ]
                    },
                    who: {
                        identifier: { value: payerId },
                        display: `Payer/${payerId}`
                    },
                    requestor: false
                }
            ],
            source: {
                observer: {
                    display: 'FHIR Server CDex Operations'
                }
            },
            entity: [
                {
                    type: {
                        system: 'http://terminology.hl7.org/CodeSystem/audit-entity-type',
                        code: '2',
                        display: 'System Object'
                    },
                    detail: [
                        { type: 'correlationId', valueString: correlationId },
                        { type: 'requestId', valueString: requestId },
                        { type: 'workflowStage', valueString: WORKFLOW_STAGES.CDEX_SUBMIT_ATTACHMENT },
                        { type: 'tenantId', valueString: tenantId },
                        { type: 'payerId', valueString: payerId },
                        ...(trackingId ? [{ type: 'trackingId', valueString: trackingId }] : []),
                        ...(organizationId ? [{ type: 'organizationId', valueString: organizationId }] : []),
                        ...(providerId ? [{ type: 'providerId', valueString: providerId }] : []),
                        ...(attachmentCount !== undefined
                            ? [{ type: 'attachmentCount', valueString: String(attachmentCount) }]
                            : []),
                        ...(isFinal !== undefined
                            ? [{ type: 'isFinal', valueString: String(isFinal) }]
                            : [])
                    ]
                }
            ]
        };
    }
}

module.exports = {
    SubmitAttachmentOperation
};
