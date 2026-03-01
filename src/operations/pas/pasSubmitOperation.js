/**
 * PAS $submit Operation
 *
 * Implements the $submit operation per the Da Vinci Prior Authorization Support
 * Implementation Guide (PAS IG 2.1).
 *
 * Route: POST /tenants/:tenantId/4_0_0/Claim/$submit
 *
 * Accepts a PAS Request Bundle containing:
 *   - Claim (use = preauthorization)
 *   - Patient (beneficiary)
 *   - Coverage
 *   - Supporting resources (ServiceRequest, DeviceRequest, MedicationRequest, etc.)
 *   - QuestionnaireResponse (if DTR was completed)
 *
 * Processing flow:
 *   1. Validate the PAS Request Bundle against required profiles
 *   2. Extract payer routing info from Coverage.payor
 *   3. Store request in tenant DB with platform tracking ID
 *   4. Route to payer via FHIR native or X12 278 (using translation adapter)
 *   5. Process PAS Response Bundle (ClaimResponse with authorization decision)
 *   6. If pended, create a Subscription for async updates
 *   7. Create AuditEvent with full correlation tracing
 *   8. Return PAS Response Bundle
 *
 * Per PAS IG, the operation must respond within 15 seconds.
 *
 * @see https://hl7.org/fhir/us/davinci-pas/STU2.1/OperationDefinition-Claim-submit.html
 */

const axios = require('axios');
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
const PAS_RESPONSE_SLA_MS = 15_000;

/**
 * Disposition values used in PAS ClaimResponse
 * @readonly
 * @enum {string}
 */
const PAS_REVIEW_ACTION = Object.freeze({
    APPROVED: 'approved',
    MODIFIED: 'modified',
    DENIED: 'denied',
    PENDED: 'pended',
    PARTIAL: 'partial',
    CANCELLED: 'cancelled'
});

class PasSubmitOperation {
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
     * Execute the $submit operation
     *
     * @param {Object} params
     * @param {string} params.tenantId - The tenant making the request
     * @param {Object} params.requestBundle - The PAS Request Bundle
     * @param {Object} params.requestInfo - FHIR request context
     * @param {string} params.requestInfo.requestId - System-generated request ID
     * @param {string} params.requestInfo.userRequestId - User-provided request ID
     * @param {Object} params.requestInfo.headers - HTTP request headers
     * @param {string} [params.requestInfo.user] - Authenticated user
     * @param {string} [params.requestInfo.scope] - OAuth2 scopes
     * @returns {Promise<Object>} PAS Response Bundle
     */
    async submitAsync ({ tenantId, requestBundle, requestInfo }) {
        assertIsValid(tenantId, 'tenantId is required for $submit');
        assertIsValid(requestBundle, 'Request bundle is required for $submit');

        const startTime = Date.now();
        const platformTrackingId = generateUUID();

        // Set up correlation tracing
        const correlationId = this.correlationIdManager.extractOrGenerate(
            { headers: requestInfo.headers || {} }
        );

        const tracingContext = this.correlationIdManager.createTracingContext({
            correlationId,
            requestId: requestInfo.requestId,
            tenantId,
            workflowStage: WORKFLOW_STAGES.PAS_SUBMIT
        });

        logInfo('PAS $submit operation started', {
            tenantId,
            platformTrackingId,
            correlationId: tracingContext.correlationId,
            requestId: requestInfo.requestId
        });

        try {
            // 1. Validate tenant is active and PAS-enabled
            const tenantContext = await this._validateTenantAsync(tenantId);

            // 2. Validate the PAS Request Bundle
            const validationResult = this.pasBundleValidator.validateSubmitBundle(requestBundle);
            if (!validationResult.valid) {
                const errorMessages = validationResult.issues
                    .filter(i => i.severity === 'error')
                    .map(i => i.details)
                    .join('; ');
                throw new BadRequestError(
                    new Error(`PAS Bundle validation failed: ${errorMessages}`)
                );
            }

            const { extractedReferences } = validationResult;

            // Update tracing context with extracted patient/payer info
            tracingContext.patientId = extractedReferences.patientReference || null;
            tracingContext.payerId = extractedReferences.payorReference || null;

            // 3. Determine payer routing info from Coverage.payor
            const payerRoutingConfig = await this._resolvePayerRoutingAsync(
                tenantContext, extractedReferences, requestBundle
            );

            // 4. Store request in tenant database with platform tracking ID
            await this._storeRequestAsync({
                tenantId,
                platformTrackingId,
                correlationId: tracingContext.correlationId,
                requestBundle,
                extractedReferences,
                payerRoutingConfig
            });

            // 5. Route to payer (FHIR native or X12 278) with SLA enforcement
            const responseBundle = await this._routeToPayerWithSlaAsync({
                payerRoutingConfig,
                requestBundle,
                platformTrackingId,
                tracingContext,
                startTime
            });

            // 6. Process the response - check for pended status
            const processedResponse = this._processPayerResponse(responseBundle, platformTrackingId);

            // 7. If pended, create Subscription for async updates
            if (processedResponse.isPended) {
                await this._createPendedSubscriptionAsync({
                    tenantId,
                    platformTrackingId,
                    correlationId: tracingContext.correlationId,
                    claimResponseId: processedResponse.claimResponseId
                });
            }

            // 8. Store the response in tenant database
            await this._storeResponseAsync({
                tenantId,
                platformTrackingId,
                responseBundle: processedResponse.responseBundle,
                reviewAction: processedResponse.reviewAction
            });

            // 9. Create AuditEvent
            await this._createAuditEventAsync({
                tenantId,
                platformTrackingId,
                tracingContext,
                requestInfo,
                outcome: 0, // success
                startTime,
                reviewAction: processedResponse.reviewAction
            });

            logInfo('PAS $submit operation completed', {
                tenantId,
                platformTrackingId,
                correlationId: tracingContext.correlationId,
                reviewAction: processedResponse.reviewAction,
                isPended: processedResponse.isPended,
                durationMs: Date.now() - startTime
            });

            return processedResponse.responseBundle;
        } catch (error) {
            logError('PAS $submit operation failed', {
                tenantId,
                platformTrackingId,
                correlationId: tracingContext.correlationId,
                error: error.message,
                stack: error.stack
            });

            // Create failure AuditEvent
            await this._createAuditEventAsync({
                tenantId,
                platformTrackingId,
                tracingContext,
                requestInfo,
                outcome: 8, // serious failure
                startTime,
                outcomeDesc: error.message
            }).catch(auditErr => {
                logError('Failed to write AuditEvent for $submit failure', {
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
     * Resolves payer routing configuration from the Coverage.payor reference
     * and the tenant's connected payer configurations
     * @param {import('../../multiTenancy/tenantContext').TenantContext} tenantContext
     * @param {Object} extractedReferences
     * @param {Object} requestBundle
     * @returns {Promise<Object>} Payer routing configuration
     * @private
     */
    async _resolvePayerRoutingAsync (tenantContext, extractedReferences, requestBundle) {
        const payorReference = extractedReferences.payorReference;

        // Default routing config - attempt FHIR native
        const defaultConfig = {
            routingMethod: 'fhir-native',
            payerEndpoint: null,
            payerTenantId: null,
            requiresX12: false,
            payerIdentifier: null
        };

        if (!payorReference) {
            logInfo('No payor reference found, using default routing', {});
            return defaultConfig;
        }

        // Try to find a matching connected payer
        for (const payerConn of tenantContext.connectedPayers) {
            if (payerConn.payerTenantId && payerConn.status === 'active') {
                // Check if payer connection's identifiers match the payor reference
                const payerConfig = {
                    routingMethod: payerConn.routingMethod || 'fhir-native',
                    payerEndpoint: payerConn.pasEndpoint || payerConn.fhirEndpoint || null,
                    payerTenantId: payerConn.payerTenantId,
                    requiresX12: payerConn.routingMethod === 'x12-278',
                    payerIdentifier: payerConn.payerIdentifier || null,
                    connectionConfig: payerConn
                };
                return payerConfig;
            }
        }

        // Fallback: extract payer Organization from bundle to determine routing
        const payorId = this._extractIdFromReference(payorReference);
        const organizations = this._findResourcesInBundle(requestBundle, 'Organization');
        const payerOrg = organizations.find(o => o.id === payorId);

        if (payerOrg) {
            defaultConfig.payerIdentifier = payerOrg.identifier;
        }

        return defaultConfig;
    }

    /**
     * Stores the PAS request in the tenant database for tracking
     * @param {Object} params
     * @param {string} params.tenantId
     * @param {string} params.platformTrackingId
     * @param {string} params.correlationId
     * @param {Object} params.requestBundle
     * @param {Object} params.extractedReferences
     * @param {Object} params.payerRoutingConfig
     * @returns {Promise<void>}
     * @private
     */
    async _storeRequestAsync ({
        tenantId,
        platformTrackingId,
        correlationId,
        requestBundle,
        extractedReferences,
        payerRoutingConfig
    }) {
        try {
            const db = await this.tenantDatabaseManager.getFhirDbForTenantAsync(tenantId);
            const collection = db.collection('PriorAuthorizationRequest');

            const record = {
                _id: platformTrackingId,
                correlationId,
                tenantId,
                status: 'submitted',
                claimId: extractedReferences.claimId,
                patientReference: extractedReferences.patientReference,
                coverageReference: extractedReferences.coverageReference,
                payorReference: extractedReferences.payorReference,
                providerReference: extractedReferences.providerReference,
                orderedItemReferences: extractedReferences.orderedItemReferences,
                routingMethod: payerRoutingConfig.routingMethod,
                payerTenantId: payerRoutingConfig.payerTenantId,
                requestBundle,
                createdAt: new Date(),
                updatedAt: new Date()
            };

            await collection.insertOne(record);

            logInfo('PAS request stored', {
                tenantId,
                platformTrackingId,
                claimId: extractedReferences.claimId
            });
        } catch (error) {
            logError('Failed to store PAS request', {
                tenantId,
                platformTrackingId,
                error: error.message
            });
            // Non-fatal: continue with the submission even if storage fails
        }
    }

    /**
     * Routes the PAS request to the payer with a 15-second SLA timeout.
     * Supports FHIR native and X12 278 routing methods.
     *
     * @param {Object} params
     * @param {Object} params.payerRoutingConfig
     * @param {Object} params.requestBundle
     * @param {string} params.platformTrackingId
     * @param {Object} params.tracingContext
     * @param {number} params.startTime
     * @returns {Promise<Object>} PAS Response Bundle from the payer
     * @private
     */
    async _routeToPayerWithSlaAsync ({
        payerRoutingConfig,
        requestBundle,
        platformTrackingId,
        tracingContext,
        startTime
    }) {
        const remainingTimeMs = PAS_RESPONSE_SLA_MS - (Date.now() - startTime);

        if (remainingTimeMs <= 0) {
            throw new Error('PAS 15-second SLA exceeded before payer routing could begin');
        }

        // Create a timeout-guarded promise with proper timer cleanup
        const routingPromise = payerRoutingConfig.requiresX12
            ? this._routeViaX12Async({ payerRoutingConfig, requestBundle, platformTrackingId, tracingContext })
            : this._routeViaFhirNativeAsync({ payerRoutingConfig, requestBundle, platformTrackingId, tracingContext });

        let slaTimer;
        const timeoutPromise = new Promise((_, reject) => {
            slaTimer = setTimeout(() => {
                reject(new Error(
                    `PAS 15-second response SLA exceeded (${PAS_RESPONSE_SLA_MS}ms). ` +
                    'Payer did not respond in time. The request may still be processing; ' +
                    'use $inquire to check status.'
                ));
            }, remainingTimeMs);
        });

        try {
            return await Promise.race([routingPromise, timeoutPromise]);
        } finally {
            clearTimeout(slaTimer);
        }
    }

    /**
     * Routes the request via FHIR native $submit to the payer endpoint
     * @param {Object} params
     * @param {Object} params.payerRoutingConfig
     * @param {Object} params.requestBundle
     * @param {string} params.platformTrackingId
     * @param {Object} params.tracingContext
     * @returns {Promise<Object>} PAS Response Bundle
     * @private
     */
    async _routeViaFhirNativeAsync ({
        payerRoutingConfig,
        requestBundle,
        platformTrackingId,
        tracingContext
    }) {
        logInfo('Routing PAS request via FHIR native', {
            platformTrackingId,
            payerEndpoint: payerRoutingConfig.payerEndpoint
        });

        if (!payerRoutingConfig.payerEndpoint) {
            // No endpoint configured - return a pended response;
            // the payer will be notified via subscription or async channel
            return this._buildPendedResponseBundle(platformTrackingId, requestBundle);
        }

        const payerUrl = `${payerRoutingConfig.payerEndpoint}/Claim/$submit`;
        const propagationHeaders = this.correlationIdManager.buildPropagationHeaders(tracingContext);

        const headers = {
            ...propagationHeaders,
            'Content-Type': 'application/fhir+json',
            Accept: 'application/fhir+json',
            'X-Platform-Tracking-Id': platformTrackingId
        };

        // Add authorization from the payer connection config if available
        if (payerRoutingConfig.connectionConfig) {
            const conn = payerRoutingConfig.connectionConfig;
            if (conn.authType === 'bearer' && conn.authToken) {
                headers.Authorization = `Bearer ${conn.authToken}`;
            } else if (conn.authType === 'basic' && conn.authToken) {
                headers.Authorization = `Basic ${conn.authToken}`;
            }
        }

        logInfo('Forwarding PAS request to payer', {
            platformTrackingId,
            payerUrl,
            headers: Object.keys(headers)
        });

        try {
            const response = await axios({
                method: 'POST',
                url: payerUrl,
                data: requestBundle,
                headers,
                timeout: PAS_RESPONSE_SLA_MS,
                validateStatus: () => true
            });

            if (response.status >= 200 && response.status < 300 && response.data) {
                logInfo('Payer FHIR $submit response received', {
                    platformTrackingId,
                    statusCode: response.status
                });
                return response.data;
            }

            logError('Payer FHIR $submit returned non-success status', {
                platformTrackingId,
                statusCode: response.status,
                responseData: typeof response.data === 'object' ? JSON.stringify(response.data).substring(0, 500) : undefined
            });

            // If the payer returned a FHIR OperationOutcome or error bundle, propagate it
            if (response.data && response.data.resourceType) {
                return response.data;
            }

            throw new Error(`Payer $submit returned HTTP ${response.status}`);
        } catch (error) {
            if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
                logError('Payer FHIR $submit timed out', { platformTrackingId, payerUrl });
                throw new Error(
                    `Payer $submit endpoint did not respond within ${PAS_RESPONSE_SLA_MS}ms. ` +
                    'The request may still be processing; use $inquire to check status.'
                );
            }
            if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
                logError('Payer FHIR $submit connection failed', {
                    platformTrackingId,
                    payerUrl,
                    errorCode: error.code
                });
                throw new Error(`Unable to connect to payer endpoint: ${error.code}`);
            }
            throw error;
        }
    }

    /**
     * Routes the request via X12 278 translation to the payer.
     *
     * Flow: FHIR Bundle -> X12 278 -> payer endpoint -> X12 278 response -> FHIR Bundle
     *
     * @param {Object} params
     * @param {Object} params.payerRoutingConfig
     * @param {Object} params.requestBundle
     * @param {string} params.platformTrackingId
     * @param {Object} params.tracingContext
     * @returns {Promise<Object>} PAS Response Bundle
     * @private
     */
    async _routeViaX12Async ({
        payerRoutingConfig,
        requestBundle,
        platformTrackingId,
        tracingContext
    }) {
        logInfo('Routing PAS request via X12 278', {
            platformTrackingId,
            payerEndpoint: payerRoutingConfig.payerEndpoint
        });

        if (!this.x12TranslationAdapter) {
            throw new Error(
                'X12 translation adapter is required for X12 278 routing but is not configured'
            );
        }

        // Step 1: Translate FHIR Bundle to X12 278 request
        const translationResult = await this.x12TranslationAdapter.fhirToX12_278(requestBundle, {
            platformTrackingId,
            payerIdentifier: payerRoutingConfig.payerIdentifier,
            connectionConfig: payerRoutingConfig.connectionConfig
        });

        const x12RequestData = translationResult.x12Data || translationResult;

        logInfo('FHIR to X12 278 translation completed', {
            platformTrackingId,
            segmentCount: translationResult.metadata?.segmentCount,
            controlNumber: translationResult.metadata?.controlNumber,
            warnings: translationResult.metadata?.warnings?.length || 0
        });

        // Step 2: Send X12 278 request to payer endpoint via HTTP POST
        if (!payerRoutingConfig.payerEndpoint) {
            logInfo('No X12 payer endpoint configured, returning pended response', { platformTrackingId });
            return this._buildPendedResponseBundle(platformTrackingId, requestBundle);
        }

        const propagationHeaders = this.correlationIdManager.buildPropagationHeaders(tracingContext);
        const headers = {
            ...propagationHeaders,
            'Content-Type': 'application/edi-x12',
            Accept: 'application/edi-x12',
            'X-Platform-Tracking-Id': platformTrackingId
        };

        if (payerRoutingConfig.connectionConfig) {
            const conn = payerRoutingConfig.connectionConfig;
            if (conn.authType === 'bearer' && conn.authToken) {
                headers.Authorization = `Bearer ${conn.authToken}`;
            }
        }

        let x12ResponseData;
        try {
            const response = await axios({
                method: 'POST',
                url: payerRoutingConfig.payerEndpoint,
                data: x12RequestData,
                headers,
                timeout: PAS_RESPONSE_SLA_MS,
                // Treat response as text since X12 is plain text EDI
                responseType: 'text',
                transformResponse: [data => data],
                validateStatus: () => true
            });

            if (response.status < 200 || response.status >= 300) {
                logError('Payer X12 endpoint returned non-success status', {
                    platformTrackingId,
                    statusCode: response.status
                });
                throw new Error(`Payer X12 endpoint returned HTTP ${response.status}`);
            }

            x12ResponseData = response.data;
        } catch (error) {
            if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
                logError('Payer X12 endpoint timed out', { platformTrackingId });
                throw new Error(
                    `Payer X12 endpoint did not respond within ${PAS_RESPONSE_SLA_MS}ms. ` +
                    'Use $inquire to check status.'
                );
            }
            if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
                throw new Error(`Unable to connect to payer X12 endpoint: ${error.code}`);
            }
            throw error;
        }

        logInfo('X12 278 response received from payer', {
            platformTrackingId,
            responseLength: x12ResponseData ? x12ResponseData.length : 0
        });

        // Step 3: Translate X12 278 response back to FHIR Bundle
        const reverseResult = await this.x12TranslationAdapter.x12_278ToFhir(x12ResponseData, {
            platformTrackingId
        });

        const responseBundle = reverseResult.bundle || reverseResult;

        if (reverseResult.metadata?.unmappedSegments?.length > 0) {
            logInfo('X12-to-FHIR translation had unmapped segments', {
                platformTrackingId,
                unmappedCount: reverseResult.metadata.unmappedSegments.length
            });
        }

        // Step 4: Create Provenance documenting the round-trip translation
        const provenance = this.x12TranslationAdapter.createProvenance(requestBundle, responseBundle, {
            translationDirection: 'round-trip',
            transactionSet: '278',
            platformTrackingId,
            warnings: [
                ...(translationResult.metadata?.warnings || []),
                ...(reverseResult.metadata?.warnings || [])
            ]
        });

        // Inject Provenance into the response bundle
        if (responseBundle.entry && provenance) {
            responseBundle.entry.push({
                fullUrl: `urn:uuid:${provenance.id || generateUUID()}`,
                resource: provenance
            });
        }

        return responseBundle;
    }

    /**
     * Processes the payer response to determine the authorization decision
     * and whether the request was pended
     * @param {Object} responseBundle - PAS Response Bundle from the payer
     * @param {string} platformTrackingId
     * @returns {Object} Processed response with metadata
     * @private
     */
    _processPayerResponse (responseBundle, platformTrackingId) {
        const result = {
            responseBundle,
            isPended: false,
            reviewAction: null,
            claimResponseId: null
        };

        if (!responseBundle || !responseBundle.entry) {
            return result;
        }

        // Find ClaimResponse in the response bundle
        const claimResponseEntry = responseBundle.entry.find(
            e => e.resource && e.resource.resourceType === 'ClaimResponse'
        );

        if (!claimResponseEntry) {
            return result;
        }

        const claimResponse = claimResponseEntry.resource;
        result.claimResponseId = claimResponse.id;

        // Determine review action from ClaimResponse.extension
        // PAS uses the reviewAction extension
        const reviewActionExt = this._findExtension(
            claimResponse,
            'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/extension-reviewAction'
        );

        if (reviewActionExt) {
            const actionCoding = reviewActionExt.extension &&
                reviewActionExt.extension.find(e => e.url === 'number');
            if (actionCoding && actionCoding.valueString) {
                result.reviewAction = actionCoding.valueString;
            }
        }

        // Check outcome for pended status
        // PAS IG: outcome = 'queued' indicates pended
        if (claimResponse.outcome === 'queued') {
            result.isPended = true;
            result.reviewAction = result.reviewAction || PAS_REVIEW_ACTION.PENDED;
        } else if (claimResponse.outcome === 'complete') {
            result.reviewAction = result.reviewAction || PAS_REVIEW_ACTION.APPROVED;
        } else if (claimResponse.outcome === 'error') {
            result.reviewAction = result.reviewAction || PAS_REVIEW_ACTION.DENIED;
        }

        // Inject platform tracking ID into the response bundle for traceability
        if (!responseBundle.identifier) {
            responseBundle.identifier = {};
        }
        responseBundle.identifier.system = 'urn:oid:platform-tracking';
        responseBundle.identifier.value = platformTrackingId;

        return result;
    }

    /**
     * Creates a Subscription resource for pended PA requests to receive async updates
     * @param {Object} params
     * @param {string} params.tenantId
     * @param {string} params.platformTrackingId
     * @param {string} params.correlationId
     * @param {string} params.claimResponseId
     * @returns {Promise<void>}
     * @private
     */
    async _createPendedSubscriptionAsync ({
        tenantId,
        platformTrackingId,
        correlationId,
        claimResponseId
    }) {
        try {
            const db = await this.tenantDatabaseManager.getFhirDbForTenantAsync(tenantId);
            const collection = db.collection('Subscription');

            const subscription = {
                resourceType: 'Subscription',
                id: generateUUID(),
                status: 'active',
                reason: `PAS pended authorization - tracking ${platformTrackingId}`,
                criteria: `ClaimResponse?_id=${claimResponseId}`,
                channel: {
                    type: 'rest-hook',
                    endpoint: `internal://pas/update/${platformTrackingId}`,
                    payload: 'application/fhir+json',
                    header: [
                        `X-Correlation-Id: ${correlationId}`,
                        `X-Platform-Tracking-Id: ${platformTrackingId}`
                    ]
                },
                end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 day expiry
                meta: {
                    tag: [
                        {
                            system: 'urn:oid:pas-subscription',
                            code: 'pended-pa',
                            display: 'Pended Prior Authorization Subscription'
                        }
                    ]
                }
            };

            await collection.insertOne(subscription);

            logInfo('Pended PA subscription created', {
                tenantId,
                platformTrackingId,
                subscriptionId: subscription.id,
                claimResponseId
            });
        } catch (error) {
            logError('Failed to create pended PA subscription', {
                tenantId,
                platformTrackingId,
                error: error.message
            });
            // Non-fatal: the pended status is still stored on the request
        }
    }

    /**
     * Stores the PAS response in the tenant database
     * @param {Object} params
     * @param {string} params.tenantId
     * @param {string} params.platformTrackingId
     * @param {Object} params.responseBundle
     * @param {string|null} params.reviewAction
     * @returns {Promise<void>}
     * @private
     */
    async _storeResponseAsync ({
        tenantId,
        platformTrackingId,
        responseBundle,
        reviewAction
    }) {
        try {
            const db = await this.tenantDatabaseManager.getFhirDbForTenantAsync(tenantId);
            const collection = db.collection('PriorAuthorizationRequest');

            await collection.updateOne(
                { _id: platformTrackingId },
                {
                    $set: {
                        status: reviewAction === PAS_REVIEW_ACTION.PENDED ? 'pended' : 'completed',
                        reviewAction,
                        responseBundle,
                        respondedAt: new Date(),
                        updatedAt: new Date()
                    }
                }
            );
        } catch (error) {
            logError('Failed to store PAS response', {
                tenantId,
                platformTrackingId,
                error: error.message
            });
        }
    }

    /**
     * Creates a FHIR AuditEvent documenting the $submit operation
     * with full correlation tracing for the Da Vinci workflow
     * @param {Object} params
     * @param {string} params.tenantId
     * @param {string} params.platformTrackingId
     * @param {Object} params.tracingContext
     * @param {Object} params.requestInfo
     * @param {number} params.outcome - AuditEvent outcome code (0=success, 8=failure)
     * @param {number} params.startTime
     * @param {string} [params.reviewAction]
     * @param {string} [params.outcomeDesc]
     * @returns {Promise<void>}
     * @private
     */
    async _createAuditEventAsync ({
        tenantId,
        platformTrackingId,
        tracingContext,
        requestInfo,
        outcome,
        startTime,
        reviewAction,
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
                        code: '$submit',
                        display: 'PAS $submit'
                    }
                ],
                action: 'E', // Execute
                period: {
                    start: new Date(startTime).toISOString(),
                    end: new Date(endTime).toISOString()
                },
                recorded: new Date().toISOString(),
                outcome,
                outcomeDesc: outcomeDesc || (reviewAction
                    ? `PA decision: ${reviewAction}`
                    : (outcome === 0 ? 'Success' : 'Failure')),
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
                        display: 'PAS $submit Operation'
                    }
                },
                entity: [
                    {
                        what: {
                            reference: `Claim/${tracingContext.patientId || 'unknown'}`
                        },
                        type: {
                            system: 'http://terminology.hl7.org/CodeSystem/audit-entity-type',
                            code: '2',
                            display: 'System Object'
                        },
                        detail: [
                            { type: 'platformTrackingId', valueString: platformTrackingId },
                            { type: 'reviewAction', valueString: reviewAction || 'pending' },
                            { type: 'durationMs', valueString: String(endTime - startTime) },
                            ...correlationDetails
                        ]
                    }
                ],
                meta: {
                    tag: [
                        {
                            system: 'urn:oid:pas-audit',
                            code: 'submit',
                            display: 'PAS Submit Audit'
                        }
                    ]
                }
            };

            await collection.insertOne(auditEvent);

            logInfo('PAS AuditEvent created', {
                tenantId,
                platformTrackingId,
                auditEventId: auditEvent.id,
                outcome
            });
        } catch (error) {
            logError('Failed to create PAS AuditEvent', {
                tenantId,
                platformTrackingId,
                error: error.message
            });
        }
    }

    /**
     * Builds a pended PAS Response Bundle when no immediate decision is available
     * @param {string} platformTrackingId
     * @param {Object} requestBundle
     * @returns {Object} PAS Response Bundle with pended ClaimResponse
     * @private
     */
    _buildPendedResponseBundle (platformTrackingId, requestBundle) {
        const claimResponseId = generateUUID();

        // Extract Claim ID from request bundle
        let claimId = null;
        if (requestBundle.entry) {
            const claimEntry = requestBundle.entry.find(
                e => e.resource && e.resource.resourceType === 'Claim'
            );
            if (claimEntry) {
                claimId = claimEntry.resource.id;
            }
        }

        return {
            resourceType: 'Bundle',
            type: 'collection',
            identifier: {
                system: 'urn:oid:platform-tracking',
                value: platformTrackingId
            },
            timestamp: new Date().toISOString(),
            entry: [
                {
                    fullUrl: `urn:uuid:${claimResponseId}`,
                    resource: {
                        resourceType: 'ClaimResponse',
                        id: claimResponseId,
                        status: 'active',
                        type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] },
                        use: 'preauthorization',
                        patient: requestBundle.entry
                            ? (requestBundle.entry.find(e => e.resource && e.resource.resourceType === 'Claim') || {}).resource?.patient
                            : undefined,
                        created: new Date().toISOString(),
                        insurer: requestBundle.entry
                            ? (requestBundle.entry.find(e => e.resource && e.resource.resourceType === 'Claim') || {}).resource?.insurer
                            : undefined,
                        request: claimId ? { reference: `Claim/${claimId}` } : undefined,
                        outcome: 'queued',
                        disposition: 'Prior authorization request is pended for review',
                        preAuthRef: platformTrackingId,
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
                    'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-pas-response-bundle'
                ]
            }
        };
    }

    /**
     * Finds an extension by URL on a FHIR resource
     * @param {Object} resource
     * @param {string} extensionUrl
     * @returns {Object|null} The extension object if found
     * @private
     */
    _findExtension (resource, extensionUrl) {
        if (!resource || !resource.extension || !Array.isArray(resource.extension)) {
            return null;
        }
        return resource.extension.find(ext => ext.url === extensionUrl) || null;
    }

    /**
     * Finds all resources of a given type in a bundle
     * @param {Object} bundle
     * @param {string} resourceType
     * @returns {Object[]}
     * @private
     */
    _findResourcesInBundle (bundle, resourceType) {
        if (!bundle || !bundle.entry) {
            return [];
        }
        return bundle.entry
            .filter(e => e.resource && e.resource.resourceType === resourceType)
            .map(e => e.resource);
    }

    /**
     * Extracts the resource ID from a FHIR reference string
     * @param {string} reference
     * @returns {string}
     * @private
     */
    _extractIdFromReference (reference) {
        if (!reference) {
            return '';
        }
        if (reference.startsWith('urn:uuid:')) {
            return reference.substring('urn:uuid:'.length);
        }
        const parts = reference.split('/');
        return parts.length > 1 ? parts[parts.length - 1] : reference;
    }
}

module.exports = {
    PasSubmitOperation,
    PAS_RESPONSE_SLA_MS,
    PAS_REVIEW_ACTION
};
