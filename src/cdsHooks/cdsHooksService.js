/**
 * CDS Hooks Service - Main CDS Hooks request processing engine
 *
 * Processes incoming CDS hook requests for Coverage Requirements Discovery (CRD):
 *   1. Validates the incoming hook request structure
 *   2. Resolves prefetch data from the tenant's FHIR store when not provided by the caller
 *   3. Identifies the relevant Coverage resource(s) and determines which payer to route to
 *   4. Dispatches the hook request to the correct payer's CRD endpoint
 *   5. Transforms payer CRD responses into CDS Cards
 *   6. Creates AuditEvent records for each hook invocation
 *
 * Per CDS Hooks 2.0 specification and Da Vinci CRD IG STU 2.1
 */
const { HookDispatcher } = require('./hookDispatcher');
const { CardGenerator } = require('./cardGenerator');
const { CorrelationIdManager, WORKFLOW_STAGES } = require('../tracing/correlationIdManager');
const { AuditLogger } = require('../utils/auditLogger');
const { assertTypeEquals } = require('../utils/assertType');
const { logInfo, logError, logWarn } = require('../operations/common/logging');
const { generateUUID } = require('../utils/uid.util');

/**
 * Required top-level fields in a CDS Hooks 2.0 request
 * @type {string[]}
 */
const REQUIRED_HOOK_FIELDS = ['hookInstance', 'hook', 'context'];

/**
 * Hooks that require a fhirServer URL for prefetch resolution
 * @type {string[]}
 */
const HOOKS_REQUIRING_FHIR_SERVER = [
    'order-sign',
    'order-select',
    'order-dispatch',
    'appointment-book',
    'encounter-start',
    'encounter-discharge'
];

/**
 * @typedef CdsHooksServiceProps
 * @property {HookDispatcher} hookDispatcher
 * @property {CardGenerator} cardGenerator
 * @property {CorrelationIdManager} correlationIdManager
 * @property {AuditLogger} auditLogger
 */

class CdsHooksService {
    /**
     * @param {CdsHooksServiceProps} params
     */
    constructor ({
        hookDispatcher,
        cardGenerator,
        correlationIdManager,
        auditLogger
    }) {
        /** @type {HookDispatcher} */
        this.hookDispatcher = hookDispatcher;
        assertTypeEquals(hookDispatcher, HookDispatcher);

        /** @type {CardGenerator} */
        this.cardGenerator = cardGenerator;
        assertTypeEquals(cardGenerator, CardGenerator);

        /** @type {CorrelationIdManager} */
        this.correlationIdManager = correlationIdManager;
        assertTypeEquals(correlationIdManager, CorrelationIdManager);

        /** @type {AuditLogger} */
        this.auditLogger = auditLogger;
        assertTypeEquals(auditLogger, AuditLogger);
    }

    /**
     * Process an incoming CDS hook request.
     *
     * This is the main entry point for hook processing. It orchestrates
     * validation, prefetch resolution, payer routing, and card generation.
     *
     * @param {Object} params
     * @param {Object} params.hookRequest - The CDS Hooks 2.0 request body
     * @param {string} params.serviceId - The CDS service ID being invoked
     * @param {Object} params.serviceDefinition - The service definition (from discovery)
     * @param {import('../multiTenancy/tenantContext').TenantContext} params.tenantContext
     * @param {string} params.correlationId - End-to-end correlation ID
     * @param {string} params.requestId - Unique request identifier
     * @returns {Promise<{cards: Object[], systemActions?: Object[], extension?: Object}>}
     */
    async processHookRequestAsync ({
        hookRequest,
        serviceId,
        serviceDefinition,
        tenantContext,
        correlationId,
        requestId
    }) {
        // Create tracing context for this CRD workflow stage
        const tracingContext = this.correlationIdManager.createTracingContext({
            correlationId,
            requestId,
            tenantId: tenantContext.tenantId,
            workflowStage: WORKFLOW_STAGES.CRD,
            patientId: this.extractPatientId(hookRequest),
            practitionerId: this.extractPractitionerId(hookRequest)
        });

        logInfo('Processing CDS hook request', {
            serviceId,
            hook: hookRequest.hook,
            hookInstance: hookRequest.hookInstance,
            tenantId: tenantContext.tenantId,
            correlationId,
            hasPrefetch: !!hookRequest.prefetch
        });

        try {
            // Step 1: Validate the hook request
            const validationErrors = this.validateHookRequest(hookRequest, serviceDefinition);
            if (validationErrors.length > 0) {
                logWarn('CDS hook request validation failed', {
                    errors: validationErrors,
                    serviceId,
                    correlationId
                });
                return {
                    cards: [{
                        uuid: generateUUID(),
                        summary: 'Invalid CDS Hooks Request',
                        detail: `Request validation failed: ${validationErrors.join('; ')}`,
                        indicator: 'warning',
                        source: {
                            label: 'FHIR Platform CRD Engine',
                            url: process.env.PLATFORM_BASE_URL || undefined
                        }
                    }]
                };
            }

            // Step 2: Resolve prefetch data if not provided
            const resolvedPrefetch = await this.resolvePrefetchAsync({
                hookRequest,
                serviceDefinition,
                tenantContext,
                correlationId
            });

            // Step 3: Identify the relevant Coverage resource(s) and payer(s)
            const coverageResources = this.extractCoverageResources(resolvedPrefetch);
            if (coverageResources.length === 0) {
                logInfo('No active Coverage found for CRD request', {
                    serviceId,
                    tenantId: tenantContext.tenantId,
                    correlationId
                });
                return {
                    cards: [{
                        uuid: generateUUID(),
                        summary: 'No Active Coverage Found',
                        detail: 'No active coverage was found for this patient. ' +
                            'Coverage information is required for coverage requirements discovery.',
                        indicator: 'warning',
                        source: {
                            label: 'FHIR Platform CRD Engine',
                            url: process.env.PLATFORM_BASE_URL || undefined
                        }
                    }]
                };
            }

            // Step 4: Dispatch to payer CRD services and collect responses
            const allCards = [];
            const allSystemActions = [];

            for (const coverage of coverageResources) {
                const payerIdentifier = this.extractPayerIdentifier(coverage);

                // Build the enriched hook request with resolved prefetch
                const enrichedRequest = {
                    ...hookRequest,
                    prefetch: resolvedPrefetch
                };

                // Dispatch to the payer's CRD endpoint
                const payerResponse = await this.hookDispatcher.dispatchAsync({
                    hookRequest: enrichedRequest,
                    serviceId,
                    coverage,
                    payerIdentifier,
                    tenantContext,
                    tracingContext
                });

                if (payerResponse && payerResponse.success) {
                    // Step 5: Transform payer response into CDS Cards
                    const generatedCards = this.cardGenerator.generateCards({
                        payerResponse: payerResponse.data,
                        coverage,
                        payerIdentifier,
                        serviceId,
                        tenantContext
                    });

                    allCards.push(...generatedCards.cards);
                    if (generatedCards.systemActions) {
                        allSystemActions.push(...generatedCards.systemActions);
                    }
                } else {
                    // Payer endpoint returned an error or timed out
                    logWarn('Payer CRD endpoint returned error', {
                        payerIdentifier,
                        serviceId,
                        error: payerResponse ? payerResponse.error : 'No response',
                        correlationId
                    });

                    allCards.push({
                        uuid: generateUUID(),
                        summary: 'Coverage Requirements Unavailable',
                        detail: `Unable to retrieve coverage requirements from payer` +
                            `${payerIdentifier ? ` (${payerIdentifier})` : ''}. ` +
                            'Please try again or contact the payer directly.',
                        indicator: 'warning',
                        source: {
                            label: 'FHIR Platform CRD Engine',
                            url: process.env.PLATFORM_BASE_URL || undefined
                        }
                    });
                }
            }

            // Step 6: Create AuditEvent for this hook call
            await this.createAuditEventAsync({
                hookRequest,
                serviceId,
                tenantContext,
                tracingContext,
                cardCount: allCards.length,
                coverageCount: coverageResources.length,
                requestId
            });

            return {
                cards: allCards,
                systemActions: allSystemActions.length > 0 ? allSystemActions : undefined
            };
        } catch (err) {
            logError('CDS hook processing failed', {
                error: err,
                serviceId,
                tenantId: tenantContext.tenantId,
                correlationId
            });

            // Still create an audit event for the failed request
            await this.createAuditEventAsync({
                hookRequest,
                serviceId,
                tenantContext,
                tracingContext,
                cardCount: 0,
                coverageCount: 0,
                requestId,
                error: err.message
            }).catch(auditErr => {
                logError('Failed to create audit event for failed hook', {
                    error: auditErr,
                    correlationId
                });
            });

            throw err;
        }
    }

    /**
     * Validates the incoming CDS Hooks request against the CDS Hooks 2.0 specification.
     * @param {Object} hookRequest - The hook request body
     * @param {Object} serviceDefinition - The target service definition
     * @returns {string[]} Array of validation error messages (empty if valid)
     */
    validateHookRequest (hookRequest, serviceDefinition) {
        const errors = [];

        if (!hookRequest || typeof hookRequest !== 'object') {
            return ['Request body must be a JSON object'];
        }

        // Check required fields
        for (const field of REQUIRED_HOOK_FIELDS) {
            if (!hookRequest[field]) {
                errors.push(`Missing required field: '${field}'`);
            }
        }

        // Validate hookInstance is a UUID
        if (hookRequest.hookInstance && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hookRequest.hookInstance)) {
            errors.push('hookInstance must be a valid UUID');
        }

        // Validate the hook name matches the service
        if (hookRequest.hook && serviceDefinition.hook && hookRequest.hook !== serviceDefinition.hook) {
            errors.push(
                `Hook '${hookRequest.hook}' does not match service hook '${serviceDefinition.hook}'`
            );
        }

        // Validate context has required fields based on hook type
        if (hookRequest.context) {
            const contextErrors = this.validateHookContext(hookRequest.hook, hookRequest.context);
            errors.push(...contextErrors);
        }

        // Validate fhirAuthorization if present
        if (hookRequest.fhirAuthorization) {
            if (!hookRequest.fhirAuthorization.access_token) {
                errors.push('fhirAuthorization.access_token is required when fhirAuthorization is provided');
            }
            if (!hookRequest.fhirAuthorization.token_type) {
                errors.push('fhirAuthorization.token_type is required when fhirAuthorization is provided');
            }
        }

        return errors;
    }

    /**
     * Validates the context object for a specific hook type.
     * @param {string} hookType - The hook type (e.g., 'order-sign')
     * @param {Object} context - The context object from the hook request
     * @returns {string[]} Validation errors
     */
    validateHookContext (hookType, context) {
        const errors = [];

        // All CRD hooks require patientId
        if (!context.patientId) {
            errors.push('context.patientId is required');
        }

        // Hook-specific validation
        switch (hookType) {
            case 'order-sign':
                if (!context.draftOrders) {
                    errors.push('context.draftOrders is required for order-sign hook');
                }
                break;

            case 'order-select':
                if (!context.selections || !Array.isArray(context.selections)) {
                    errors.push('context.selections is required for order-select hook');
                }
                if (!context.draftOrders) {
                    errors.push('context.draftOrders is required for order-select hook');
                }
                break;

            case 'order-dispatch':
                if (!context.order) {
                    errors.push('context.order is required for order-dispatch hook');
                }
                if (!context.performer) {
                    errors.push('context.performer is required for order-dispatch hook');
                }
                break;

            case 'appointment-book':
                if (!context.appointments) {
                    errors.push('context.appointments is required for appointment-book hook');
                }
                break;

            case 'encounter-start':
            case 'encounter-discharge':
                if (!context.encounterId) {
                    errors.push(`context.encounterId is required for ${hookType} hook`);
                }
                break;
        }

        return errors;
    }

    /**
     * Resolves prefetch data from the tenant's FHIR store when
     * the calling EHR has not provided it in the request.
     *
     * Per CDS Hooks 2.0 Section 4: Prefetch
     * @param {Object} params
     * @param {Object} params.hookRequest - The hook request
     * @param {Object} params.serviceDefinition - The service definition with prefetch templates
     * @param {import('../multiTenancy/tenantContext').TenantContext} params.tenantContext
     * @param {string} params.correlationId
     * @returns {Promise<Object>} Resolved prefetch data keyed by prefetch token name
     */
    async resolvePrefetchAsync ({ hookRequest, serviceDefinition, tenantContext, correlationId }) {
        const prefetch = hookRequest.prefetch || {};
        const requiredPrefetch = serviceDefinition.prefetch || {};

        // Check which prefetch keys are missing
        const missingKeys = Object.keys(requiredPrefetch).filter(key => !prefetch[key]);

        if (missingKeys.length === 0) {
            logInfo('All prefetch data provided by caller', {
                serviceId: serviceDefinition.id,
                correlationId
            });
            return prefetch;
        }

        logInfo('Resolving missing prefetch data from FHIR store', {
            missingKeys,
            serviceId: serviceDefinition.id,
            tenantId: tenantContext.tenantId,
            correlationId
        });

        // Determine the FHIR server URL for prefetch resolution
        const fhirServerUrl = hookRequest.fhirServer ||
            `${process.env.PLATFORM_BASE_URL || 'http://localhost:3000'}/tenants/${tenantContext.tenantId}/4_0_0`;

        // Build authorization headers for FHIR requests
        const fhirHeaders = {};
        if (hookRequest.fhirAuthorization) {
            fhirHeaders.Authorization =
                `${hookRequest.fhirAuthorization.token_type} ${hookRequest.fhirAuthorization.access_token}`;
        }

        // Resolve each missing prefetch key
        const resolvedPrefetch = { ...prefetch };
        for (const key of missingKeys) {
            const template = requiredPrefetch[key];
            try {
                const resolvedUrl = this.resolvePrefetchTemplate(template, hookRequest.context);
                const fullUrl = `${fhirServerUrl}/${resolvedUrl}`;

                logInfo('Resolving prefetch', {
                    key,
                    resolvedUrl,
                    correlationId
                });

                // Use axios (same as hookDispatcher) for internal FHIR calls
                const axios = require('axios');
                const response = await axios.get(fullUrl, {
                    headers: {
                        ...fhirHeaders,
                        Accept: 'application/fhir+json',
                        'X-Correlation-ID': correlationId
                    },
                    timeout: 10000,
                    validateStatus: (status) => status < 500
                });

                if (response.status === 200 && response.data) {
                    resolvedPrefetch[key] = response.data;
                } else {
                    logWarn('Prefetch resolution returned non-200', {
                        key,
                        status: response.status,
                        correlationId
                    });
                    resolvedPrefetch[key] = null;
                }
            } catch (err) {
                logError('Failed to resolve prefetch', {
                    key,
                    template,
                    error: err.message,
                    correlationId
                });
                resolvedPrefetch[key] = null;
            }
        }

        return resolvedPrefetch;
    }

    /**
     * Resolves a prefetch template by substituting context values.
     *
     * Templates use the format: {{context.field}} or {{context.field.subfield}}
     * @param {string} template - The prefetch URL template
     * @param {Object} context - The hook context object
     * @returns {string} Resolved URL (relative to FHIR server base)
     */
    resolvePrefetchTemplate (template, context) {
        return template.replace(/\{\{context\.([^}]+)\}\}/g, (match, path) => {
            const parts = path.split('.');
            let value = context;
            for (const part of parts) {
                if (value == null) {
                    return '';
                }
                value = value[part];
            }
            return value != null ? String(value) : '';
        });
    }

    /**
     * Extracts Coverage resources from the resolved prefetch data.
     * Looks for Coverage resources in the 'coverage' prefetch key.
     * @param {Object} prefetch - Resolved prefetch data
     * @returns {Object[]} Array of Coverage resources
     */
    extractCoverageResources (prefetch) {
        if (!prefetch || !prefetch.coverage) {
            return [];
        }

        const coverageData = prefetch.coverage;

        // Handle Bundle response
        if (coverageData.resourceType === 'Bundle' && Array.isArray(coverageData.entry)) {
            return coverageData.entry
                .filter(entry => entry.resource && entry.resource.resourceType === 'Coverage')
                .map(entry => entry.resource);
        }

        // Handle single Coverage resource
        if (coverageData.resourceType === 'Coverage') {
            return [coverageData];
        }

        return [];
    }

    /**
     * Extracts a payer identifier from a Coverage resource.
     * Uses the Coverage.payor reference to determine the responsible payer.
     * @param {Object} coverage - A FHIR Coverage resource
     * @returns {string|null} Payer identifier (tenant ID or organization reference)
     */
    extractPayerIdentifier (coverage) {
        if (!coverage || !coverage.payor || !Array.isArray(coverage.payor)) {
            return null;
        }

        // Look for the first Organization reference in payor
        for (const payor of coverage.payor) {
            if (payor.reference) {
                // Extract the identifier from "Organization/xxx" format
                const match = payor.reference.match(/^Organization\/(.+)$/);
                if (match) {
                    return match[1];
                }
                return payor.reference;
            }
            if (payor.identifier && payor.identifier.value) {
                return payor.identifier.value;
            }
        }

        return null;
    }

    /**
     * Extracts the patient ID from the hook request context.
     * @param {Object} hookRequest - The CDS hook request
     * @returns {string|null}
     */
    extractPatientId (hookRequest) {
        if (hookRequest && hookRequest.context && hookRequest.context.patientId) {
            return hookRequest.context.patientId;
        }
        return null;
    }

    /**
     * Extracts the practitioner ID from the hook request context.
     * @param {Object} hookRequest - The CDS hook request
     * @returns {string|null}
     */
    extractPractitionerId (hookRequest) {
        if (hookRequest && hookRequest.context && hookRequest.context.userId) {
            // userId typically in format "Practitioner/123"
            const match = hookRequest.context.userId.match(/^Practitioner\/(.+)$/);
            return match ? match[1] : hookRequest.context.userId;
        }
        return null;
    }

    /**
     * Creates an AuditEvent for a CDS hook invocation.
     * Records the hook call for compliance and tracing purposes.
     *
     * @param {Object} params
     * @param {Object} params.hookRequest - The hook request
     * @param {string} params.serviceId - The CDS service ID
     * @param {import('../multiTenancy/tenantContext').TenantContext} params.tenantContext
     * @param {Object} params.tracingContext - Correlation tracing context
     * @param {number} params.cardCount - Number of cards returned
     * @param {number} params.coverageCount - Number of coverage resources found
     * @param {string} params.requestId - Unique request identifier
     * @param {string} [params.error] - Error message if the hook call failed
     * @returns {Promise<void>}
     */
    async createAuditEventAsync ({
        hookRequest,
        serviceId,
        tenantContext,
        tracingContext,
        cardCount,
        coverageCount,
        requestId,
        error
    }) {
        try {
            const patientId = this.extractPatientId(hookRequest);
            const practitionerId = this.extractPractitionerId(hookRequest);

            const requestInfo = {
                requestId,
                user: practitionerId || 'system',
                isUser: false,
                remoteIpAddress: '0.0.0.0',
                scope: 'system/CoverageRequirements.read',
                alternateUserId: null
            };

            const auditArgs = {
                hookInstance: hookRequest.hookInstance || 'unknown',
                hook: hookRequest.hook || 'unknown',
                serviceId,
                tenantId: tenantContext.tenantId,
                correlationId: tracingContext.correlationId,
                cardCount: String(cardCount),
                coverageCount: String(coverageCount)
            };

            if (error) {
                auditArgs.error = error;
            }

            const ids = [];
            if (patientId) {
                ids.push(patientId);
            }

            await this.auditLogger.logAuditEntryAsync({
                requestInfo,
                base_version: '4_0_0',
                resourceType: 'Patient',
                operation: 'execute',
                args: auditArgs,
                ids
            });

            logInfo('CDS hook audit event created', {
                serviceId,
                hookInstance: hookRequest.hookInstance,
                correlationId: tracingContext.correlationId
            });
        } catch (err) {
            logError('Failed to create CDS hook audit event', {
                error: err,
                serviceId,
                correlationId: tracingContext ? tracingContext.correlationId : 'unknown'
            });
            // Do not re-throw - audit failures should not break the hook response
        }
    }
}

module.exports = {
    CdsHooksService
};
