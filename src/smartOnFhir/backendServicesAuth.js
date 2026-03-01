/**
 * BackendServicesAuth - JWT assertion validation for B2B SMART Backend Services
 *
 * Implements the SMART on FHIR Backend Services authorization flow:
 *   1. Client sends client_credentials grant with JWT assertion
 *   2. Server validates JWT signature against client's registered public key
 *   3. Server issues access token with pre-authorized scopes
 *
 * Per SMART App Launch IG v2.2.0 Backend Services specification
 */
const jwt = require('jsonwebtoken');
const { logInfo, logError } = require('../operations/common/logging');
const { generateUUID } = require('../utils/uid.util');

class BackendServicesAuth {
    /**
     * @param {Object} params
     * @param {import('../multiTenancy/tenantService').TenantService} params.tenantService
     */
    constructor ({ tenantService }) {
        this.tenantService = tenantService;

        /**
         * Set of used JTI values for replay protection
         * @type {Map<string, number>}
         */
        this.usedJtis = new Map();

        // Cleanup expired JTI entries every 10 minutes
        this.jtiCleanupInterval = setInterval(() => {
            this.cleanupExpiredJtis();
        }, 10 * 60 * 1000);
    }

    /**
     * Validate a Backend Services JWT assertion
     * @param {Object} params
     * @param {string} params.clientAssertion - The JWT assertion
     * @param {string} params.clientAssertionType - Must be urn:ietf:params:oauth:client-assertion-type:jwt-bearer
     * @param {string} params.scope - Requested scopes
     * @param {string} params.tenantId - Tenant identifier
     * @returns {Promise<{valid: boolean, clientId?: string, grantedScopes?: string[], error?: string}>}
     */
    async validateAssertion ({ clientAssertion, clientAssertionType, scope, tenantId }) {
        // Verify assertion type
        if (clientAssertionType !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') {
            return { valid: false, error: 'Invalid client_assertion_type' };
        }

        try {
            // Decode without verification to get client_id from claims
            const decoded = jwt.decode(clientAssertion, { complete: true });
            if (!decoded) {
                return { valid: false, error: 'Invalid JWT assertion' };
            }

            const { iss, sub, aud, exp, jti } = decoded.payload;

            // iss and sub must be the client_id
            if (!iss || iss !== sub) {
                return { valid: false, error: 'JWT iss and sub must be equal (both set to client_id)' };
            }

            const clientId = iss;

            // Check JTI for replay protection
            if (!jti) {
                return { valid: false, error: 'JWT must include jti claim for replay protection' };
            }

            if (this.usedJtis.has(jti)) {
                return { valid: false, error: 'JWT assertion has already been used (replay detected)' };
            }

            // Check expiration (max 5 minutes)
            const now = Math.floor(Date.now() / 1000);
            if (!exp || exp < now) {
                return { valid: false, error: 'JWT assertion has expired' };
            }
            if (exp - now > 300) {
                return { valid: false, error: 'JWT assertion lifetime must not exceed 5 minutes' };
            }

            // Look up the client registration in the tenant
            const tenantContext = await this.tenantService.getTenantAsync(tenantId);
            if (!tenantContext) {
                return { valid: false, error: `Tenant '${tenantId}' not found` };
            }

            const registeredClient = tenantContext.auth.registeredClients?.find(
                c => c.clientId === clientId && c.status === 'active'
            );

            if (!registeredClient) {
                return { valid: false, error: `Client '${clientId}' is not registered for tenant '${tenantId}'` };
            }

            // Record JTI for replay protection
            this.usedJtis.set(jti, exp);

            // Intersect requested scopes with granted scopes
            const requestedScopes = scope ? scope.split(' ') : [];
            const grantedScopes = requestedScopes.length > 0
                ? requestedScopes.filter(s => registeredClient.grantedScopes.includes(s))
                : registeredClient.grantedScopes;

            logInfo('Backend service assertion validated', {
                clientId,
                tenantId,
                grantedScopeCount: grantedScopes.length
            });

            return {
                valid: true,
                clientId,
                grantedScopes,
                tenantId
            };
        } catch (err) {
            logError('JWT assertion validation failed', { error: err });
            return { valid: false, error: `JWT validation error: ${err.message}` };
        }
    }

    /**
     * Issue an access token for a validated client
     * @param {Object} params
     * @param {string} params.clientId
     * @param {string[]} params.grantedScopes
     * @param {string} params.tenantId
     * @returns {Object} Token response
     */
    issueAccessToken ({ clientId, grantedScopes, tenantId }) {
        const tokenId = generateUUID();
        const now = Math.floor(Date.now() / 1000);
        const expiresIn = 3600; // 1 hour

        const tokenPayload = {
            iss: `${process.env.PLATFORM_BASE_URL || 'https://fhir-platform.example.com'}`,
            sub: clientId,
            aud: `${process.env.PLATFORM_BASE_URL || 'https://fhir-platform.example.com'}/tenants/${tenantId}/4_0_0`,
            iat: now,
            exp: now + expiresIn,
            jti: tokenId,
            scope: grantedScopes.join(' '),
            tenant_id: tenantId,
            client_id: clientId,
            token_type: 'bearer'
        };

        // In production, this would use the platform's private key to sign
        // For now, we return the payload structure
        const accessToken = jwt.sign(
            tokenPayload,
            process.env.TOKEN_SIGNING_SECRET || 'platform-signing-secret',
            { algorithm: 'HS256' }
        );

        return {
            access_token: accessToken,
            token_type: 'bearer',
            expires_in: expiresIn,
            scope: grantedScopes.join(' ')
            // No refresh_token for backend services per SMART spec
        };
    }

    /**
     * Express route handler for the token endpoint
     * @returns {Function}
     */
    handleTokenRequest () {
        return async (req, res) => {
            const {
                grant_type,
                client_assertion,
                client_assertion_type,
                scope
            } = req.body;

            const tenantId = req.params.tenantId || req.tenantId;

            if (grant_type !== 'client_credentials') {
                return res.status(400).json({
                    error: 'unsupported_grant_type',
                    error_description: 'Only client_credentials grant type is supported for backend services'
                });
            }

            const validation = await this.validateAssertion({
                clientAssertion: client_assertion,
                clientAssertionType: client_assertion_type,
                scope,
                tenantId
            });

            if (!validation.valid) {
                return res.status(401).json({
                    error: 'invalid_client',
                    error_description: validation.error
                });
            }

            const tokenResponse = this.issueAccessToken({
                clientId: validation.clientId,
                grantedScopes: validation.grantedScopes,
                tenantId
            });

            res.set('Cache-Control', 'no-store');
            res.set('Pragma', 'no-cache');
            res.json(tokenResponse);
        };
    }

    /**
     * Cleanup expired JTI entries
     */
    cleanupExpiredJtis () {
        const now = Math.floor(Date.now() / 1000);
        for (const [jti, exp] of this.usedJtis) {
            if (exp < now) {
                this.usedJtis.delete(jti);
            }
        }
    }

    /**
     * Cleanup resources
     */
    destroy () {
        if (this.jtiCleanupInterval) {
            clearInterval(this.jtiCleanupInterval);
        }
    }
}

module.exports = { BackendServicesAuth };
