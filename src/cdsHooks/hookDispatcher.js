/**
 * HookDispatcher - Routes CDS hook calls to the correct payer's CRD service endpoint
 *
 * Responsibilities:
 *   - Looks up payer CRD endpoints from the tenant's connectedPayers configuration
 *   - Forwards the hook request to the payer with proper headers (correlation ID, auth)
 *   - Handles timeout (5 second default per CRD IG guidance) and error cases
 *   - Maps payer organization identifiers to CRD endpoint URLs
 *
 * Per Da Vinci CRD IG STU 2.1, payer CRD endpoints should respond within
 * a short timeframe to support real-time clinical decision support.
 */
const axios = require('axios');
const { CorrelationIdManager, CORRELATION_ID_HEADER } = require('../tracing/correlationIdManager');
const { TenantConfigManager } = require('../multiTenancy/tenantConfigManager');
const { assertTypeEquals } = require('../utils/assertType');
const { logInfo, logError, logWarn } = require('../operations/common/logging');

/**
 * Default timeout for payer CRD service calls in milliseconds.
 * CRD IG recommends responses within a few seconds for real-time CDS.
 * @type {number}
 */
const DEFAULT_PAYER_TIMEOUT_MS = 5000;

/**
 * Maximum number of retry attempts for transient failures
 * @type {number}
 */
const MAX_RETRIES = 1;

/**
 * @typedef HookDispatcherProps
 * @property {CorrelationIdManager} correlationIdManager
 * @property {TenantConfigManager} tenantConfigManager
 */

class HookDispatcher {
    /**
     * @param {HookDispatcherProps} params
     */
    constructor ({ correlationIdManager, tenantConfigManager }) {
        /** @type {CorrelationIdManager} */
        this.correlationIdManager = correlationIdManager;
        assertTypeEquals(correlationIdManager, CorrelationIdManager);

        /** @type {TenantConfigManager} */
        this.tenantConfigManager = tenantConfigManager;
        assertTypeEquals(tenantConfigManager, TenantConfigManager);
    }

    /**
     * Dispatches a CDS hook request to the appropriate payer's CRD endpoint.
     *
     * @param {Object} params
     * @param {Object} params.hookRequest - The enriched CDS hook request (with resolved prefetch)
     * @param {string} params.serviceId - The CDS service ID being invoked
     * @param {Object} params.coverage - The FHIR Coverage resource identifying the payer
     * @param {string|null} params.payerIdentifier - Extracted payer identifier
     * @param {import('../multiTenancy/tenantContext').TenantContext} params.tenantContext
     * @param {Object} params.tracingContext - Correlation tracing context
     * @returns {Promise<{success: boolean, data?: Object, error?: string, statusCode?: number}>}
     */
    async dispatchAsync ({
        hookRequest,
        serviceId,
        coverage,
        payerIdentifier,
        tenantContext,
        tracingContext
    }) {
        const correlationId = tracingContext.correlationId;

        // Step 1: Resolve the payer's CRD endpoint
        const payerEndpoint = this.resolvePayerEndpoint({
            payerIdentifier,
            serviceId,
            tenantContext
        });

        if (!payerEndpoint) {
            logWarn('No payer CRD endpoint configured', {
                payerIdentifier,
                serviceId,
                tenantId: tenantContext.tenantId,
                correlationId
            });
            return {
                success: false,
                error: `No CRD endpoint configured for payer '${payerIdentifier || 'unknown'}'`
            };
        }

        logInfo('Dispatching hook to payer CRD endpoint', {
            payerIdentifier,
            serviceId,
            endpoint: payerEndpoint.url,
            tenantId: tenantContext.tenantId,
            correlationId
        });

        // Step 2: Build the outbound request headers
        const headers = this.buildRequestHeaders({
            payerEndpoint,
            tracingContext,
            tenantContext
        });

        // Step 3: Build the request body (strip any tenant-internal metadata)
        const requestBody = this.buildRequestBody({
            hookRequest,
            serviceId
        });

        // Step 4: Make the HTTP call with timeout and retry
        const timeoutMs = payerEndpoint.timeoutMs || DEFAULT_PAYER_TIMEOUT_MS;

        return this.executeWithRetryAsync({
            url: payerEndpoint.url,
            method: 'POST',
            headers,
            data: requestBody,
            timeoutMs,
            maxRetries: payerEndpoint.retryEnabled ? MAX_RETRIES : 0,
            correlationId,
            payerIdentifier,
            serviceId
        });
    }

    /**
     * Resolves the payer CRD endpoint URL from the tenant's connectedPayers configuration.
     *
     * Looks up endpoints in the following order:
     *   1. Direct match on payerIdentifier in connectedPayers[].payerTenantId
     *   2. Match on payerIdentifier in connectedPayers[].payerOrganizationId
     *   3. Default/fallback endpoint if configured
     *
     * @param {Object} params
     * @param {string|null} params.payerIdentifier - The payer identifier from Coverage.payor
     * @param {string} params.serviceId - The CDS service ID
     * @param {import('../multiTenancy/tenantContext').TenantContext} params.tenantContext
     * @returns {{url: string, authType: string, authToken?: string, timeoutMs?: number, retryEnabled?: boolean}|null}
     */
    resolvePayerEndpoint ({ payerIdentifier, serviceId, tenantContext }) {
        const connectedPayers = tenantContext.connectedPayers || [];

        if (connectedPayers.length === 0) {
            return null;
        }

        // Try to find a matching payer connection
        let payerConnection = null;

        if (payerIdentifier) {
            // Match by payerTenantId
            payerConnection = connectedPayers.find(
                p => p.payerTenantId === payerIdentifier && p.status === 'active'
            );

            // Match by payerOrganizationId
            if (!payerConnection) {
                payerConnection = connectedPayers.find(
                    p => p.payerOrganizationId === payerIdentifier && p.status === 'active'
                );
            }
        }

        // Fall back to default payer if no specific match
        if (!payerConnection) {
            payerConnection = connectedPayers.find(
                p => p.isDefault === true && p.status === 'active'
            );
        }

        if (!payerConnection) {
            return null;
        }

        // Extract the CRD endpoint from the payer connection
        const crdConfig = payerConnection.crdEndpoints || payerConnection.endpoints || {};
        const endpointUrl = crdConfig[serviceId] || crdConfig.default;

        if (!endpointUrl) {
            logWarn('Payer connection found but no CRD endpoint URL configured', {
                payerIdentifier,
                payerTenantId: payerConnection.payerTenantId,
                serviceId,
                availableEndpoints: Object.keys(crdConfig)
            });
            return null;
        }

        return {
            url: endpointUrl,
            authType: payerConnection.authType || 'bearer',
            authToken: payerConnection.authToken || null,
            clientId: payerConnection.clientId || null,
            timeoutMs: crdConfig.timeoutMs || DEFAULT_PAYER_TIMEOUT_MS,
            retryEnabled: crdConfig.retryEnabled !== false,
            payerTenantId: payerConnection.payerTenantId
        };
    }

    /**
     * Builds the HTTP headers for the outbound payer request.
     * Includes correlation ID propagation, authorization, and content type.
     *
     * @param {Object} params
     * @param {Object} params.payerEndpoint - Resolved payer endpoint configuration
     * @param {Object} params.tracingContext - Correlation tracing context
     * @param {import('../multiTenancy/tenantContext').TenantContext} params.tenantContext
     * @returns {Object} HTTP headers
     */
    buildRequestHeaders ({ payerEndpoint, tracingContext, tenantContext }) {
        // Start with correlation/tracing headers
        const headers = {
            ...this.correlationIdManager.buildPropagationHeaders(tracingContext),
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Request-Tenant': tenantContext.tenantId,
            'X-Request-Source': 'fhir-platform-crd-engine'
        };

        // Add authorization
        if (payerEndpoint.authType === 'bearer' && payerEndpoint.authToken) {
            headers.Authorization = `Bearer ${payerEndpoint.authToken}`;
        } else if (payerEndpoint.authType === 'basic' && payerEndpoint.authToken) {
            headers.Authorization = `Basic ${payerEndpoint.authToken}`;
        }

        return headers;
    }

    /**
     * Builds the request body to forward to the payer CRD endpoint.
     * Strips any platform-internal metadata that should not be forwarded.
     *
     * @param {Object} params
     * @param {Object} params.hookRequest - The enriched hook request
     * @param {string} params.serviceId - The service ID
     * @returns {Object} Cleaned request body
     */
    buildRequestBody ({ hookRequest, serviceId }) {
        // Create a clean copy without internal fields
        const {
            _internalMetadata,
            _tenantContext,
            ...cleanRequest
        } = hookRequest;

        return cleanRequest;
    }

    /**
     * Executes the HTTP request to the payer with retry logic.
     *
     * @param {Object} params
     * @param {string} params.url - The payer CRD endpoint URL
     * @param {string} params.method - HTTP method
     * @param {Object} params.headers - Request headers
     * @param {Object} params.data - Request body
     * @param {number} params.timeoutMs - Timeout in milliseconds
     * @param {number} params.maxRetries - Maximum retry attempts
     * @param {string} params.correlationId - Correlation ID for logging
     * @param {string|null} params.payerIdentifier - Payer identifier for logging
     * @param {string} params.serviceId - Service ID for logging
     * @returns {Promise<{success: boolean, data?: Object, error?: string, statusCode?: number}>}
     */
    async executeWithRetryAsync ({
        url,
        method,
        headers,
        data,
        timeoutMs,
        maxRetries,
        correlationId,
        payerIdentifier,
        serviceId
    }) {
        let lastError = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    logInfo('Retrying payer CRD request', {
                        attempt,
                        maxRetries,
                        url,
                        correlationId
                    });
                    // Exponential backoff: 500ms * attempt
                    await this.delay(500 * attempt);
                }

                const startTime = Date.now();

                const response = await axios({
                    method,
                    url,
                    headers,
                    data,
                    timeout: timeoutMs,
                    validateStatus: () => true // Handle all status codes ourselves
                });

                const elapsedMs = Date.now() - startTime;

                logInfo('Payer CRD response received', {
                    statusCode: response.status,
                    elapsedMs,
                    payerIdentifier,
                    serviceId,
                    correlationId
                });

                // Successful response
                if (response.status >= 200 && response.status < 300) {
                    return {
                        success: true,
                        data: response.data,
                        statusCode: response.status
                    };
                }

                // Client error - do not retry
                if (response.status >= 400 && response.status < 500) {
                    return {
                        success: false,
                        error: `Payer returned HTTP ${response.status}: ${this.extractErrorMessage(response.data)}`,
                        statusCode: response.status
                    };
                }

                // Server error - may retry
                lastError = `Payer returned HTTP ${response.status}`;

            } catch (err) {
                lastError = err.message;

                // Timeout error
                if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
                    logWarn('Payer CRD request timed out', {
                        timeoutMs,
                        attempt,
                        payerIdentifier,
                        serviceId,
                        correlationId
                    });
                    lastError = `Request timed out after ${timeoutMs}ms`;

                    // Do not retry on timeout - CRD should be fast
                    return {
                        success: false,
                        error: lastError,
                        statusCode: 504
                    };
                }

                // Connection error - may retry
                if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
                    logError('Payer CRD endpoint unreachable', {
                        error: err.message,
                        url,
                        attempt,
                        correlationId
                    });
                    lastError = `Payer endpoint unreachable: ${err.message}`;
                    continue;
                }

                // Other error - do not retry
                logError('Unexpected error calling payer CRD endpoint', {
                    error: err,
                    url,
                    correlationId
                });

                return {
                    success: false,
                    error: `Unexpected error: ${err.message}`
                };
            }
        }

        // All retries exhausted
        return {
            success: false,
            error: lastError || 'All retry attempts failed'
        };
    }

    /**
     * Extracts a human-readable error message from a payer error response.
     * @param {Object|string|null} responseData - The response body
     * @returns {string} Error message
     */
    extractErrorMessage (responseData) {
        if (!responseData) {
            return 'No response body';
        }

        if (typeof responseData === 'string') {
            return responseData.substring(0, 200);
        }

        // OperationOutcome format
        if (responseData.resourceType === 'OperationOutcome' && Array.isArray(responseData.issue)) {
            return responseData.issue
                .map(i => i.diagnostics || i.details?.text || i.code)
                .filter(Boolean)
                .join('; ');
        }

        // Generic error format
        if (responseData.error) {
            return typeof responseData.error === 'string'
                ? responseData.error
                : JSON.stringify(responseData.error).substring(0, 200);
        }

        return JSON.stringify(responseData).substring(0, 200);
    }

    /**
     * Delays execution for the specified number of milliseconds.
     * @param {number} ms - Milliseconds to delay
     * @returns {Promise<void>}
     */
    delay (ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = {
    HookDispatcher,
    DEFAULT_PAYER_TIMEOUT_MS
};
