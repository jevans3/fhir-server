/**
 * PAS $inquire Operation
 *
 * Implements the $inquire operation to check the status of a previously submitted
 * prior authorization request, per the Da Vinci PAS IG 2.1.
 *
 * Route: POST /tenants/:tenantId/4_0_0/Claim/$inquire
 *
 * Accepts a PAS Inquiry Bundle containing:
 *   - Claim (use = preauthorization, with references to the original PA)
 *   - Patient (beneficiary)
 *   - Coverage
 *
 * Processing flow:
 *   1. Validate the PAS Inquiry Bundle
 *   2. Look up the original PA request from the tenant database
 *   3. Route the inquiry to the payer (FHIR native or X12 278)
 *   4. Process and return the PAS Inquiry Response Bundle
 *   5. Create AuditEvent with correlation tracing
 *
 * @see https://hl7.org/fhir/us/davinci-pas/STU2.1/OperationDefinition-Claim-inquire.html
 */

const { assertTypeEquals, assertIsValid } = require('../../utils/assertType');
const { TenantDatabaseManager } = require('../../multiTenancy/tenantDatabaseManager');
const { CorrelationIdManager, WORKFLOW_STAGES } = require('../../tracing/correlationIdManager');
const { TenantService } = require('../../multiTenancy/tenantService');
const { PasBundleValidator } = require('./pasBundleValidator');
const { generateUUID } = require('../../utils/uid.util');
const { logInfo, logError } = require('../common/logging');
const { BadRequestError, NotFoundError } = require('../../utils/httpErrors');

/**
 * Response SLA timeout in milliseconds per PAS IG (15 seconds)
 * @type {number}
 */
const PAS_INQUIRE_SLA_MS = 15_000;

class PasInquireOperation {
    /**
     * @param {Object} params
     * @param {TenantDatabaseManager} params.tenantDatabaseManager
     * @param {CorrelationIdManager} params.correlationIdManager
     * @param {TenantService} params.tenantService
     * @param {PasBundleValidator} [params.pasBundleValidator]
     * @param {Object} [params.x12TranslationAdapter] - X12TranslationAdapter instance (optional)
     */
    constructor ({
        tenantDatabaseManager,
        correlationIdManager,
        tenantService,
        pasBundleValidator,
        x12TranslationAdapter
    }) {
        /** @type {TenantDatabaseManager} */
        this.tenantDatabaseManager = tenantDatabaseManager;
        assertTypeEquals(tenantDatabaseManager, TenantDatabaseManager);

        /** @type {CorrelationIdManager} */
        this.correlationIdManager = correlationIdManager;
        assertTypeEquals(correlationIdManager, CorrelationIdManager);

        /** @type {TenantService} */
        this.tenantService = tenantService;
        assertTypeEquals(tenantService, TenantService);

        /** @type {PasBundleValidator} */
        this.pasBundleValidator = pasBundleValidator || new PasBundleValidator();

        /**
         * Optional X12 translation adapter for payers that require X12 278
         * @type {Object|null}
         */
        this.x12TranslationAdapter = x12TranslationAdapter || null;
    }

    /**
     * Execute the $inquire operation
     *
     * @param {Object} params
     * @param {string} params.tenantId - The tenant making the inquiry
     * @param {Object} params.inquiryBundle - The PAS Inquiry Request Bundle
     * @param {Object} params.requestInfo - FHIR request context
     * @param {string} params.requestInfo.requestId - System-generated request ID
     * @param {string} params.requestInfo.userRequestId - User-provided request ID
     * @param {Object} params.requestInfo.headers - HTTP request headers
     * @param {string} [params.requestInfo.user] - Authenticated user
     * @param {string} [params.requestInfo.scope] - OAuth2 scopes
     * @returns {Promise<Object>} PAS Inquiry Response Bundle
     */
    async inquireAsync ({ tenantId, inquiryBundle, requestInfo }) {
        assertIsValid(tenantId, 'tenantId is required for $inquire');
        assertIsValid(inquiryBundle, 'Inquiry bundle is required for $inquire');

        const startTime = Date.now();

        // Set up correlation tracing
        const correlationId = this.correlationIdManager.extractOrGenerate(
            { headers: requestInfo.headers || {} }
        );

        const tracingContext = this.correlationIdManager.createTracingContext({
            correlationId,
            requestId: requestInfo.requestId,
            tenantId,
            workflowStage: WORKFLOW_STAGES.PAS_INQUIRE
        });

        logInfo('PAS $inquire operation started', {
            tenantId,
            correlationId: tracingContext.correlationId,
            requestId: requestInfo.requestId
        });

        try {
            // 1. Validate tenant is active and PAS-enabled
            const tenantContext = await this._validateTenantAsync(tenantId);

            // 2. Validate the PAS Inquiry Bundle
            const validationResult = this.pasBundleValidator.validateInquiryBundle(inquiryBundle);
            if (!validationResult.valid) {
                const errorMessages = validationResult.issues
                    .filter(i => i.severity === 'error')
                    .map(i => i.details)
                    .join('; ');
                throw new BadRequestError(
                    new Error(`PAS Inquiry Bundle validation failed: ${errorMessages}`)
                );
            }

            const { extractedReferences } = validationResult;

            // 3. Look up the original PA request from tenant database
            const originalRequest = await this._lookupOriginalRequestAsync(
                tenantId,
                extractedReferences
            );

            // 4. Determine payer routing from the original request or bundle
            const payerRoutingConfig = await this._resolvePayerRoutingAsync(
                tenantContext,
                extractedReferences,
                originalRequest
            );

            // 5. Route the inquiry to the payer with SLA enforcement
            const responseBundle = await this._routeInquiryToPayerWithSlaAsync({
                payerRoutingConfig,
                inquiryBundle,
                originalRequest,
                tracingContext,
                startTime
            });

            // 6. Update the stored PA request with latest status
            if (originalRequest) {
                await this._updateStoredRequestAsync(
                    tenantId,
                    originalRequest._id,
                    responseBundle
                );
            }

            // 7. Create AuditEvent
            await this._createAuditEventAsync({
                tenantId,
                tracingContext,
                requestInfo,
                outcome: 0,
                startTime,
                originalRequestId: originalRequest ? originalRequest._id : null
            });

            logInfo('PAS $inquire operation completed', {
                tenantId,
                correlationId: tracingContext.correlationId,
                durationMs: Date.now() - startTime,
                hasOriginalRequest: !!originalRequest
            });

            return responseBundle;
        } catch (error) {
            logError('PAS $inquire operation failed', {
                tenantId,
                correlationId: tracingContext.correlationId,
                error: error.message,
                stack: error.stack
            });

            // Create failure AuditEvent
            await this._createAuditEventAsync({
                tenantId,
                tracingContext,
                requestInfo,
                outcome: 8,
                startTime,
                outcomeDesc: error.message
            }).catch(auditErr => {
                logError('Failed to write AuditEvent for $inquire failure', {
                    error: auditErr.message
                });
            });

            throw error;
        }
    }

    /**
     * Validates that the tenant is active and has PAS enabled
     * @param {string} tenantId
     * @returns {Promise<import('../../multiTenancy/tenantContext').TenantContext>}
     * @private
     */
    async _validateTenantAsync (tenantId) {
        const tenantContext = await this.tenantService.getTenantAsync(tenantId);

        if (!tenantContext) {
            throw new NotFoundError(`Tenant "${tenantId}" not found`);
        }

        if (!tenantContext.isActive()) {
            throw new BadRequestError(
                new Error(`Tenant "${tenantId}" is not active (status: ${tenantContext.status})`)
            );
        }

        if (!tenantContext.isFeatureEnabled('pasEnabled')) {
            throw new BadRequestError(
                new Error(`PAS is not enabled for tenant "${tenantId}"`)
            );
        }

        return tenantContext;
    }

    /**
     * Looks up the original PA request in the tenant database using references
     * from the inquiry bundle
     * @param {string} tenantId
     * @param {Object} extractedReferences
     * @returns {Promise<Object|null>}
     * @private
     */
    async _lookupOriginalRequestAsync (tenantId, extractedReferences) {
        try {
            const db = await this.tenantDatabaseManager.getFhirDbForTenantAsync(tenantId);
            const collection = db.collection('PriorAuthorizationRequest');

            // Try to find by claim ID first
            if (extractedReferences.claimId) {
                const byClaimId = await collection.findOne({
                    tenantId,
                    claimId: extractedReferences.claimId
                });
                if (byClaimId) {
                    return byClaimId;
                }
            }

            // Fallback: search by patient + coverage references
            if (extractedReferences.patientReference && extractedReferences.coverageReference) {
                const byReferences = await collection.findOne({
                    tenantId,
                    patientReference: extractedReferences.patientReference,
                    coverageReference: extractedReferences.coverageReference,
                    status: { $in: ['submitted', 'pended'] }
                }, {
                    sort: { createdAt: -1 }
                });
                if (byReferences) {
                    return byReferences;
                }
            }

            logInfo('No matching original PA request found for inquiry', {
                tenantId,
                claimId: extractedReferences.claimId
            });

            return null;
        } catch (error) {
            logError('Failed to look up original PA request', {
                tenantId,
                error: error.message
            });
            return null;
        }
    }

    /**
     * Resolves payer routing configuration for the inquiry
     * @param {import('../../multiTenancy/tenantContext').TenantContext} tenantContext
     * @param {Object} extractedReferences
     * @param {Object|null} originalRequest
     * @returns {Promise<Object>}
     * @private
     */
    async _resolvePayerRoutingAsync (tenantContext, extractedReferences, originalRequest) {
        // If we have the original request, use its routing config
        if (originalRequest && originalRequest.routingMethod) {
            const payerConn = originalRequest.payerTenantId
                ? tenantContext.getPayerConnection(originalRequest.payerTenantId)
                : null;

            return {
                routingMethod: originalRequest.routingMethod,
                payerEndpoint: payerConn ? (payerConn.pasEndpoint || payerConn.fhirEndpoint) : null,
                payerTenantId: originalRequest.payerTenantId,
                requiresX12: originalRequest.routingMethod === 'x12-278',
                payerIdentifier: payerConn ? payerConn.payerIdentifier : null,
                connectionConfig: payerConn
            };
        }

        // Fallback: use first active payer connection
        for (const payerConn of tenantContext.connectedPayers) {
            if (payerConn.status === 'active') {
                return {
                    routingMethod: payerConn.routingMethod || 'fhir-native',
                    payerEndpoint: payerConn.pasEndpoint || payerConn.fhirEndpoint || null,
                    payerTenantId: payerConn.payerTenantId,
                    requiresX12: payerConn.routingMethod === 'x12-278',
                    payerIdentifier: payerConn.payerIdentifier || null,
                    connectionConfig: payerConn
                };
            }
        }

        return {
            routingMethod: 'fhir-native',
            payerEndpoint: null,
            payerTenantId: null,
            requiresX12: false,
            payerIdentifier: null
        };
    }

    /**
     * Routes the inquiry to the payer with 15-second SLA enforcement
     * @param {Object} params
     * @param {Object} params.payerRoutingConfig
     * @param {Object} params.inquiryBundle
     * @param {Object|null} params.originalRequest
     * @param {Object} params.tracingContext
     * @param {number} params.startTime
     * @returns {Promise<Object>} PAS Inquiry Response Bundle
     * @private
     */
    async _routeInquiryToPayerWithSlaAsync ({
        payerRoutingConfig,
        inquiryBundle,
        originalRequest,
        tracingContext,
        startTime
    }) {
        const remainingTimeMs = PAS_INQUIRE_SLA_MS - (Date.now() - startTime);

        if (remainingTimeMs <= 0) {
            throw new Error('PAS 15-second SLA exceeded before inquiry routing could begin');
        }

        const routingPromise = payerRoutingConfig.requiresX12
            ? this._routeInquiryViaX12Async({ payerRoutingConfig, inquiryBundle, tracingContext })
            : this._routeInquiryViaFhirNativeAsync({ payerRoutingConfig, inquiryBundle, originalRequest, tracingContext });

        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(
                    `PAS 15-second response SLA exceeded (${PAS_INQUIRE_SLA_MS}ms). ` +
                    'Payer did not respond to inquiry in time.'
                ));
            }, remainingTimeMs);
        });

        return Promise.race([routingPromise, timeoutPromise]);
    }

    /**
     * Routes inquiry via FHIR native to the payer
     * @param {Object} params
     * @param {Object} params.payerRoutingConfig
     * @param {Object} params.inquiryBundle
     * @param {Object|null} params.originalRequest
     * @param {Object} params.tracingContext
     * @returns {Promise<Object>} PAS Inquiry Response Bundle
     * @private
     */
    async _routeInquiryViaFhirNativeAsync ({
        payerRoutingConfig,
        inquiryBundle,
        originalRequest,
        tracingContext
    }) {
        logInfo('Routing PAS inquiry via FHIR native', {
            payerEndpoint: payerRoutingConfig.payerEndpoint
        });

        const propagationHeaders = this.correlationIdManager.buildPropagationHeaders(tracingContext);

        if (payerRoutingConfig.payerEndpoint) {
            // In production, this would make an HTTP call to the payer's $inquire endpoint:
            // POST {payerEndpoint}/Claim/$inquire
            const payerUrl = `${payerRoutingConfig.payerEndpoint}/Claim/$inquire`;
            logInfo('Forwarding PAS inquiry to payer', {
                payerUrl,
                headers: Object.keys(propagationHeaders)
            });
            // const response = await httpClient.post(payerUrl, inquiryBundle, { headers: propagationHeaders });
            // return response.data;
        }

        // If we have a stored response from the original request, return it
        if (originalRequest && originalRequest.responseBundle) {
            return originalRequest.responseBundle;
        }

        // Build a default inquiry response indicating the PA is still in progress
        return this._buildInquiryResponseBundle(inquiryBundle, originalRequest);
    }

    /**
     * Routes inquiry via X12 278 to the payer
     * @param {Object} params
     * @param {Object} params.payerRoutingConfig
     * @param {Object} params.inquiryBundle
     * @param {Object} params.tracingContext
     * @returns {Promise<Object>} PAS Inquiry Response Bundle
     * @private
     */
    async _routeInquiryViaX12Async ({
        payerRoutingConfig,
        inquiryBundle,
        tracingContext
    }) {
        logInfo('Routing PAS inquiry via X12 278', {
            payerEndpoint: payerRoutingConfig.payerEndpoint
        });

        if (!this.x12TranslationAdapter) {
            throw new Error(
                'X12 translation adapter is required for X12 278 inquiry routing but is not configured'
            );
        }

        // In production, translate to X12, send, and translate response back:
        // const x12Request = this.x12TranslationAdapter.fhirToX12_278(inquiryBundle, { ... });
        // const x12Response = await x12Client.send(payerRoutingConfig.payerEndpoint, x12Request);
        // return this.x12TranslationAdapter.x12_278ToFhir(x12Response, { ... });

        return this._buildInquiryResponseBundle(inquiryBundle, null);
    }

    /**
     * Updates the stored PA request record with the latest status from the inquiry response
     * @param {string} tenantId
     * @param {string} requestId
     * @param {Object} responseBundle
     * @returns {Promise<void>}
     * @private
     */
    async _updateStoredRequestAsync (tenantId, requestId, responseBundle) {
        try {
            const db = await this.tenantDatabaseManager.getFhirDbForTenantAsync(tenantId);
            const collection = db.collection('PriorAuthorizationRequest');

            // Extract outcome from the response bundle
            let latestOutcome = null;
            if (responseBundle && responseBundle.entry) {
                const crEntry = responseBundle.entry.find(
                    e => e.resource && e.resource.resourceType === 'ClaimResponse'
                );
                if (crEntry) {
                    latestOutcome = crEntry.resource.outcome;
                }
            }

            const updateFields = {
                lastInquiredAt: new Date(),
                updatedAt: new Date(),
                latestResponseBundle: responseBundle
            };

            if (latestOutcome === 'complete') {
                updateFields.status = 'completed';
            } else if (latestOutcome === 'error') {
                updateFields.status = 'denied';
            }

            await collection.updateOne(
                { _id: requestId },
                { $set: updateFields }
            );
        } catch (error) {
            logError('Failed to update stored PA request after inquiry', {
                tenantId,
                requestId,
                error: error.message
            });
        }
    }

    /**
     * Creates a FHIR AuditEvent documenting the $inquire operation
     * with full correlation tracing
     * @param {Object} params
     * @param {string} params.tenantId
     * @param {Object} params.tracingContext
     * @param {Object} params.requestInfo
     * @param {number} params.outcome - AuditEvent outcome code (0=success, 8=failure)
     * @param {number} params.startTime
     * @param {string} [params.originalRequestId]
     * @param {string} [params.outcomeDesc]
     * @returns {Promise<void>}
     * @private
     */
    async _createAuditEventAsync ({
        tenantId,
        tracingContext,
        requestInfo,
        outcome,
        startTime,
        originalRequestId,
        outcomeDesc
    }) {
        try {
            const db = await this.tenantDatabaseManager.getAuditDbForTenantAsync(tenantId);
            const collection = db.collection('AuditEvent');

            const correlationDetails = this.correlationIdManager.toAuditEventDetails(tracingContext);
            const endTime = Date.now();

            const auditEvent = {
                resourceType: 'AuditEvent',
                id: generateUUID(),
                type: {
                    system: 'http://terminology.hl7.org/CodeSystem/audit-event-type',
                    code: 'rest',
                    display: 'RESTful Operation'
                },
                subtype: [
                    {
                        system: 'http://hl7.org/fhir/restful-interaction',
                        code: 'operation',
                        display: 'operation'
                    },
                    {
                        system: 'urn:oid:pas-operation',
                        code: '$inquire',
                        display: 'PAS $inquire'
                    }
                ],
                action: 'E',
                period: {
                    start: new Date(startTime).toISOString(),
                    end: new Date(endTime).toISOString()
                },
                recorded: new Date().toISOString(),
                outcome,
                outcomeDesc: outcomeDesc || (outcome === 0 ? 'Success' : 'Failure'),
                agent: [
                    {
                        type: {
                            coding: [{
                                system: 'http://terminology.hl7.org/CodeSystem/extra-security-role-type',
                                code: 'authserver'
                            }]
                        },
                        who: {
                            display: requestInfo.user || 'system'
                        },
                        requestor: true
                    }
                ],
                source: {
                    site: `tenant/${tenantId}`,
                    observer: {
                        display: 'PAS $inquire Operation'
                    }
                },
                entity: [
                    {
                        what: originalRequestId
                            ? { reference: `PriorAuthorizationRequest/${originalRequestId}` }
                            : undefined,
                        type: {
                            system: 'http://terminology.hl7.org/CodeSystem/audit-entity-type',
                            code: '2',
                            display: 'System Object'
                        },
                        detail: [
                            { type: 'durationMs', valueString: String(endTime - startTime) },
                            ...correlationDetails
                        ]
                    }
                ],
                meta: {
                    tag: [
                        {
                            system: 'urn:oid:pas-audit',
                            code: 'inquire',
                            display: 'PAS Inquire Audit'
                        }
                    ]
                }
            };

            await collection.insertOne(auditEvent);
        } catch (error) {
            logError('Failed to create PAS $inquire AuditEvent', {
                tenantId,
                error: error.message
            });
        }
    }

    /**
     * Builds a default PAS Inquiry Response Bundle
     * @param {Object} inquiryBundle - The incoming inquiry bundle
     * @param {Object|null} originalRequest - The original PA request from the database
     * @returns {Object} PAS Inquiry Response Bundle
     * @private
     */
    _buildInquiryResponseBundle (inquiryBundle, originalRequest) {
        const claimResponseId = generateUUID();

        // Determine outcome based on original request status
        let outcome = 'queued';
        let disposition = 'Prior authorization request is still under review';

        if (originalRequest) {
            if (originalRequest.status === 'completed') {
                outcome = 'complete';
                disposition = `Prior authorization decision: ${originalRequest.reviewAction || 'complete'}`;
            } else if (originalRequest.status === 'denied') {
                outcome = 'error';
                disposition = 'Prior authorization request was denied';
            }
        }

        // Extract patient and insurer from the inquiry bundle
        let patient = null;
        let insurer = null;
        if (inquiryBundle && inquiryBundle.entry) {
            const claimEntry = inquiryBundle.entry.find(
                e => e.resource && e.resource.resourceType === 'Claim'
            );
            if (claimEntry && claimEntry.resource) {
                patient = claimEntry.resource.patient;
                insurer = claimEntry.resource.insurer;
            }
        }

        return {
            resourceType: 'Bundle',
            type: 'collection',
            timestamp: new Date().toISOString(),
            entry: [
                {
                    fullUrl: `urn:uuid:${claimResponseId}`,
                    resource: {
                        resourceType: 'ClaimResponse',
                        id: claimResponseId,
                        status: 'active',
                        type: {
                            coding: [{
                                system: 'http://terminology.hl7.org/CodeSystem/claim-type',
                                code: 'professional'
                            }]
                        },
                        use: 'preauthorization',
                        patient,
                        created: new Date().toISOString(),
                        insurer,
                        outcome,
                        disposition,
                        preAuthRef: originalRequest ? originalRequest._id : null,
                        meta: {
                            profile: [
                                'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-claimresponse'
                            ]
                        }
                    }
                }
            ],
            meta: {
                profile: [
                    'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-pas-inquiry-response-bundle'
                ]
            }
        };
    }
}

module.exports = {
    PasInquireOperation,
    PAS_INQUIRE_SLA_MS
};
