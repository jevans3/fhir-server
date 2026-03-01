/**
 * DtrService - Business logic service for Da Vinci Documentation Templates and Rules (DTR) IG 2.1
 *
 * Manages questionnaire package caching, payer DTR endpoint resolution,
 * and DTR session tracking for audit/tracing purposes.
 *
 * @see https://build.fhir.org/ig/HL7/davinci-dtr/
 */
const crypto = require('crypto');
const { assertTypeEquals, assertIsValid } = require('../../utils/assertType');
const { TenantService } = require('../../multiTenancy/tenantService');
const { CorrelationIdManager, WORKFLOW_STAGES } = require('../../tracing/correlationIdManager');
const { logInfo, logError, logDebug } = require('../common/logging');
const { NotFoundError, BadRequestError } = require('../../utils/httpErrors');

/**
 * Cache key separator
 * @type {string}
 */
const CACHE_KEY_SEP = '::';

/**
 * Default cache TTL in milliseconds (15 minutes)
 * @type {number}
 */
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;

class DtrService {
    /**
     * @typedef {Object} DtrServiceParams
     * @property {TenantService} tenantService
     * @property {CorrelationIdManager} correlationIdManager
     */

    /**
     * @param {DtrServiceParams} params
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

        /**
         * Questionnaire package cache
         * Key: tenantId::payerTenantId::coverageType
         * Value: { bundle, cachedAt, expiresAt }
         * @type {Map<string, {bundle: Object, cachedAt: number, expiresAt: number}>}
         */
        this.packageCache = new Map();

        /**
         * Cache TTL in milliseconds
         * @type {number}
         */
        this.cacheTtlMs = DEFAULT_CACHE_TTL_MS;

        /**
         * Active DTR sessions for audit/tracing
         * Key: sessionId
         * Value: { tenantId, payerTenantId, correlationId, questionnaireId, startedAt, lastActivity, status }
         * @type {Map<string, Object>}
         */
        this.activeSessions = new Map();

        /**
         * Maximum number of sessions to track in memory
         * @type {number}
         */
        this.maxTrackedSessions = 5000;
    }

    /**
     * Build a cache key for questionnaire package caching
     * @param {string} tenantId
     * @param {string} payerTenantId
     * @param {string} coverageType - Coverage type code (e.g. insurance plan type)
     * @returns {string}
     */
    buildCacheKey (tenantId, payerTenantId, coverageType) {
        return [tenantId, payerTenantId, coverageType].join(CACHE_KEY_SEP);
    }

    /**
     * Get a cached questionnaire package if available and not expired
     * @param {string} tenantId
     * @param {string} payerTenantId
     * @param {string} coverageType
     * @returns {Object|null} The cached Bundle or null if not found/expired
     */
    getCachedPackage (tenantId, payerTenantId, coverageType) {
        const key = this.buildCacheKey(tenantId, payerTenantId, coverageType);
        const cached = this.packageCache.get(key);

        if (!cached) {
            return null;
        }

        if (Date.now() > cached.expiresAt) {
            this.packageCache.delete(key);
            logDebug('DTR package cache expired', { tenantId, payerTenantId, coverageType });
            return null;
        }

        logDebug('DTR package cache hit', { tenantId, payerTenantId, coverageType });
        return cached.bundle;
    }

    /**
     * Store a questionnaire package in the cache
     * @param {string} tenantId
     * @param {string} payerTenantId
     * @param {string} coverageType
     * @param {Object} bundle - The questionnaire package Bundle
     * @param {number} [ttlMs] - Optional TTL override in milliseconds
     */
    setCachedPackage (tenantId, payerTenantId, coverageType, bundle, ttlMs) {
        const key = this.buildCacheKey(tenantId, payerTenantId, coverageType);
        const now = Date.now();

        this.packageCache.set(key, {
            bundle,
            cachedAt: now,
            expiresAt: now + (ttlMs || this.cacheTtlMs)
        });

        logDebug('DTR package cached', { tenantId, payerTenantId, coverageType });

        // Evict oldest entries if cache grows too large
        if (this.packageCache.size > 1000) {
            this.evictExpiredCacheEntries();
        }
    }

    /**
     * Invalidate cached questionnaire packages for a given tenant/payer combination
     * @param {string} tenantId
     * @param {string} [payerTenantId] - If omitted, invalidates all packages for the tenant
     */
    invalidateCache (tenantId, payerTenantId) {
        const prefix = payerTenantId
            ? `${tenantId}${CACHE_KEY_SEP}${payerTenantId}`
            : `${tenantId}${CACHE_KEY_SEP}`;

        for (const key of this.packageCache.keys()) {
            if (key.startsWith(prefix)) {
                this.packageCache.delete(key);
            }
        }

        logInfo('DTR package cache invalidated', { tenantId, payerTenantId: payerTenantId || 'all' });
    }

    /**
     * Remove expired entries from the package cache
     * @private
     */
    evictExpiredCacheEntries () {
        const now = Date.now();
        for (const [key, entry] of this.packageCache.entries()) {
            if (now > entry.expiresAt) {
                this.packageCache.delete(key);
            }
        }
    }

    /**
     * Resolve the payer DTR endpoint from tenant configuration
     * @param {string} tenantId - The provider tenant ID
     * @param {string} payerTenantId - The payer tenant ID from the Coverage resource
     * @returns {Promise<{questionnairePackageUrl: string, nextQuestionUrl: string, authConfig: Object}>}
     * @throws {NotFoundError} if tenant or payer connection not found
     * @throws {BadRequestError} if DTR is not enabled or endpoint is not configured
     */
    async resolvePayerDtrEndpointAsync (tenantId, payerTenantId) {
        const tenantContext = await this.tenantService.getTenantAsync(tenantId);

        if (!tenantContext) {
            throw new NotFoundError(`Tenant '${tenantId}' not found`);
        }

        if (!tenantContext.isFeatureEnabled('dtrEnabled')) {
            throw new BadRequestError(
                new Error(`DTR is not enabled for tenant '${tenantId}'`)
            );
        }

        const payerConnection = tenantContext.getPayerConnection(payerTenantId);
        if (!payerConnection) {
            throw new NotFoundError(
                `No payer connection found for payer '${payerTenantId}' on tenant '${tenantId}'`
            );
        }

        const dtrEndpoints = payerConnection.dtrEndpoints || payerConnection.endpoints?.dtr;
        if (!dtrEndpoints || !dtrEndpoints.questionnairePackageUrl) {
            throw new BadRequestError(
                new Error(
                    `DTR questionnaire-package endpoint not configured for payer '${payerTenantId}' on tenant '${tenantId}'`
                )
            );
        }

        return {
            questionnairePackageUrl: dtrEndpoints.questionnairePackageUrl,
            nextQuestionUrl: dtrEndpoints.nextQuestionUrl || null,
            authConfig: payerConnection.authConfig || {}
        };
    }

    /**
     * Extract the payer tenant ID from a Coverage resource
     * @param {Object} coverageResource - The FHIR Coverage resource
     * @returns {string|null} The payer tenant ID or null
     */
    extractPayerIdFromCoverage (coverageResource) {
        if (!coverageResource) {
            return null;
        }

        // Check payor reference (Coverage.payor)
        const payorRef = coverageResource.payor?.[0]?.reference;
        if (payorRef) {
            // Extract the Organization ID from the reference
            const parts = payorRef.split('/');
            return parts.length > 1 ? parts[parts.length - 1] : payorRef;
        }

        // Fallback: check identifier for payer tenant ID
        const tenantIdentifier = coverageResource.identifier?.find(
            id => id.system === 'urn:ietf:rfc:3986' || id.system?.includes('tenant')
        );
        return tenantIdentifier?.value || null;
    }

    /**
     * Extract the coverage type from a Coverage resource
     * @param {Object} coverageResource - The FHIR Coverage resource
     * @returns {string} The coverage type code, or 'unknown' if not found
     */
    extractCoverageType (coverageResource) {
        if (!coverageResource) {
            return 'unknown';
        }

        // Coverage.type is a CodeableConcept
        const typeCode = coverageResource.type?.coding?.[0]?.code;
        return typeCode || 'unknown';
    }

    /**
     * Create a new DTR session for tracking
     * @param {Object} params
     * @param {string} params.tenantId
     * @param {string} params.payerTenantId
     * @param {string} params.correlationId
     * @param {string} [params.questionnaireId]
     * @param {string} [params.patientId]
     * @param {string} [params.coverageId]
     * @returns {string} sessionId
     */
    createSession ({ tenantId, payerTenantId, correlationId, questionnaireId, patientId, coverageId }) {
        assertIsValid(tenantId, 'tenantId is required for DTR session');
        assertIsValid(correlationId, 'correlationId is required for DTR session');

        // Evict oldest sessions if at capacity
        if (this.activeSessions.size >= this.maxTrackedSessions) {
            const oldestKeys = Array.from(this.activeSessions.keys()).slice(0, 100);
            oldestKeys.forEach(k => this.activeSessions.delete(k));
        }

        const sessionId = `dtr-${tenantId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const now = new Date().toISOString();

        this.activeSessions.set(sessionId, {
            sessionId,
            tenantId,
            payerTenantId,
            correlationId,
            questionnaireId: questionnaireId || null,
            patientId: patientId || null,
            coverageId: coverageId || null,
            startedAt: now,
            lastActivity: now,
            status: 'active',
            interactions: []
        });

        logInfo('DTR session created', { sessionId, tenantId, payerTenantId, correlationId });
        return sessionId;
    }

    /**
     * Record an interaction in a DTR session
     * @param {string} sessionId
     * @param {Object} interaction
     * @param {string} interaction.type - 'questionnaire-package' | 'next-question' | 'store-response'
     * @param {string} [interaction.questionnaireId]
     * @param {boolean} [interaction.success]
     * @param {string} [interaction.error]
     */
    recordSessionInteraction (sessionId, interaction) {
        const session = this.activeSessions.get(sessionId);
        if (!session) {
            logDebug('DTR session not found for interaction recording', { sessionId });
            return;
        }

        const now = new Date().toISOString();
        session.lastActivity = now;
        session.interactions.push({
            ...interaction,
            timestamp: now
        });

        // Update questionnaireId if provided
        if (interaction.questionnaireId) {
            session.questionnaireId = interaction.questionnaireId;
        }
    }

    /**
     * Complete a DTR session
     * @param {string} sessionId
     * @param {string} [outcome] - 'completed' | 'abandoned' | 'error'
     */
    completeSession (sessionId, outcome) {
        const session = this.activeSessions.get(sessionId);
        if (!session) {
            return;
        }

        session.status = outcome || 'completed';
        session.completedAt = new Date().toISOString();

        logInfo('DTR session completed', {
            sessionId,
            tenantId: session.tenantId,
            outcome: session.status,
            interactionCount: session.interactions.length
        });
    }

    /**
     * Get a DTR session by ID
     * @param {string} sessionId
     * @returns {Object|null}
     */
    getSession (sessionId) {
        return this.activeSessions.get(sessionId) || null;
    }

    /**
     * Get all active DTR sessions for a tenant
     * @param {string} tenantId
     * @returns {Object[]}
     */
    getActiveSessionsForTenant (tenantId) {
        const sessions = [];
        for (const session of this.activeSessions.values()) {
            if (session.tenantId === tenantId && session.status === 'active') {
                sessions.push(session);
            }
        }
        return sessions;
    }

    /**
     * Build an AuditEvent resource for a DTR operation
     * @param {Object} params
     * @param {string} params.tenantId
     * @param {string} params.correlationId
     * @param {string} params.operationType - 'questionnaire-package' | 'next-question'
     * @param {string} params.requestId
     * @param {string} [params.payerTenantId]
     * @param {string} [params.patientId]
     * @param {string} [params.questionnaireId]
     * @param {string} params.outcome - 'success' | 'error'
     * @param {string} [params.outcomeDesc]
     * @returns {Object} FHIR AuditEvent resource
     */
    buildAuditEvent ({
        tenantId,
        correlationId,
        operationType,
        requestId,
        payerTenantId,
        patientId,
        questionnaireId,
        outcome,
        outcomeDesc
    }) {
        const now = new Date().toISOString();
        return {
            resourceType: 'AuditEvent',
            type: {
                system: 'http://dicom.nema.org/resources/ontology/DCM',
                code: '110112',
                display: 'Query'
            },
            subtype: [
                {
                    system: 'http://hl7.org/fhir/us/davinci-dtr',
                    code: operationType,
                    display: `DTR ${operationType}`
                }
            ],
            action: 'E',
            period: {
                start: now
            },
            recorded: now,
            outcome: outcome === 'success' ? '0' : '8',
            outcomeDesc: outcomeDesc || `DTR ${operationType} ${outcome}`,
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
                }
            ],
            source: {
                observer: {
                    display: 'FHIR Server DTR Operations'
                }
            },
            entity: [
                {
                    what: questionnaireId
                        ? { reference: `Questionnaire/${questionnaireId}` }
                        : undefined,
                    type: {
                        system: 'http://terminology.hl7.org/CodeSystem/audit-entity-type',
                        code: '2',
                        display: 'System Object'
                    },
                    detail: [
                        { type: 'correlationId', valueString: correlationId },
                        { type: 'requestId', valueString: requestId },
                        { type: 'workflowStage', valueString: WORKFLOW_STAGES.DTR },
                        { type: 'tenantId', valueString: tenantId },
                        ...(payerTenantId ? [{ type: 'payerTenantId', valueString: payerTenantId }] : []),
                        ...(patientId ? [{ type: 'patientId', valueString: patientId }] : [])
                    ]
                }
            ]
        };
    }
}

module.exports = {
    DtrService
};
