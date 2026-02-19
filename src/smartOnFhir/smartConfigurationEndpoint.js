/**
 * SMART on FHIR Configuration Endpoint
 *
 * Implements: GET /.well-known/smart-configuration
 * Per tenant: GET /tenants/:tenantId/.well-known/smart-configuration
 *
 * Conforms to SMART App Launch IG v2.2.0
 * Required by CMS-0057-F for Prior Authorization API
 */
const { logInfo } = require('../operations/common/logging');

class SmartConfigurationEndpoint {
    /**
     * @param {Object} params
     * @param {import('../multiTenancy/tenantConfigManager').TenantConfigManager} params.tenantConfigManager
     */
    constructor ({ tenantConfigManager }) {
        this.tenantConfigManager = tenantConfigManager;
    }

    /**
     * Build SMART configuration for a specific tenant
     * @param {Object} params
     * @param {string} params.tenantId
     * @param {Object} params.tenantContext
     * @param {string} params.baseUrl - Platform base URL
     * @returns {Object} SMART configuration JSON
     */
    buildConfiguration ({ tenantId, tenantContext, baseUrl }) {
        const tenantBaseUrl = `${baseUrl}/tenants/${tenantId}`;

        const config = {
            // Required fields per SMART App Launch IG
            issuer: tenantBaseUrl,
            authorization_endpoint: `${tenantBaseUrl}/auth/authorize`,
            token_endpoint: `${tenantBaseUrl}/auth/token`,
            jwks_uri: `${tenantBaseUrl}/.well-known/jwks.json`,

            // Registration (dynamic client registration)
            registration_endpoint: `${tenantBaseUrl}/auth/register`,

            // Supported scopes for this tenant
            scopes_supported: this.getScopesForTenant(tenantContext),

            // OAuth2 response types
            response_types_supported: ['code'],

            // Management endpoints
            management_endpoint: `${tenantBaseUrl}/auth/manage`,
            introspection_endpoint: `${tenantBaseUrl}/auth/introspect`,
            revocation_endpoint: `${tenantBaseUrl}/auth/revoke`,

            // Auth methods (Backend Services uses private_key_jwt)
            token_endpoint_auth_methods_supported: [
                'private_key_jwt',
                'client_secret_basic'
            ],
            token_endpoint_auth_signing_alg_values_supported: [
                'RS384',
                'ES384'
            ],

            // SMART capabilities
            capabilities: this.getCapabilitiesForTenant(tenantContext),

            // PKCE support
            code_challenge_methods_supported: ['S256'],

            // Grant types
            grant_types_supported: [
                'authorization_code',
                'client_credentials'
            ]
        };

        return config;
    }

    /**
     * Get supported scopes for a tenant based on their type and features
     * @param {Object} tenantContext
     * @returns {string[]}
     */
    getScopesForTenant (tenantContext) {
        const scopes = [
            // Base OIDC scopes
            'openid',
            'fhirUser',
            'offline_access',
            'online_access',

            // SMART launch scopes
            'launch',
            'launch/patient',
            'launch/encounter',

            // System scopes (Backend Services for B2B)
            'system/Patient.rs',
            'system/Practitioner.rs',
            'system/Organization.rs',
            'system/Coverage.rs',
            'system/Encounter.rs',
            'system/Condition.rs',
            'system/Observation.rs',
            'system/Procedure.rs',
            'system/MedicationRequest.rs',
            'system/ServiceRequest.rs',
            'system/DeviceRequest.rs',
            'system/DocumentReference.cruds',
            'system/QuestionnaireResponse.cruds',
            'system/Questionnaire.rs',
            'system/Task.cruds',
            'system/AuditEvent.rs',

            // User scopes
            'user/Patient.rs',
            'user/Coverage.rs',
            'user/Claim.cruds',
            'user/ClaimResponse.rs',

            // Patient scopes
            'patient/Patient.rs',
            'patient/Coverage.rs',
            'patient/Observation.rs',
            'patient/Condition.rs'
        ];

        // Add PAS-specific scopes
        if (tenantContext && tenantContext.isFeatureEnabled('pasEnabled')) {
            scopes.push(
                'system/Claim.cruds',
                'system/ClaimResponse.rs',
                'system/Bundle.cruds'
            );
        }

        // Add CDex-specific scopes
        if (tenantContext && tenantContext.isFeatureEnabled('cdexEnabled')) {
            scopes.push(
                'system/Task.cruds',
                'system/DocumentReference.cruds',
                'system/Communication.cruds'
            );
        }

        // Remove duplicates
        return [...new Set(scopes)];
    }

    /**
     * Get SMART capabilities for a tenant
     * @param {Object} tenantContext
     * @returns {string[]}
     */
    getCapabilitiesForTenant (tenantContext) {
        const capabilities = [
            'launch-ehr',
            'launch-standalone',
            'client-public',
            'client-confidential-asymmetric',
            'client-confidential-symmetric',
            'sso-openid-connect',
            'context-ehr-patient',
            'context-ehr-encounter',
            'context-standalone-patient',
            'permission-v2',
            'permission-v1'  // Backward compatibility
        ];

        return capabilities;
    }

    /**
     * Express route handler for SMART configuration
     * @returns {Function}
     */
    handleSmartConfiguration () {
        return (req, res) => {
            const tenantId = req.params.tenantId || req.tenantId || 'default';
            const tenantContext = req.tenantContext || null;
            const protocol = req.protocol || 'https';
            const baseUrl = `${protocol}://${req.get('host')}`;

            logInfo('SMART configuration requested', { tenantId });

            const config = this.buildConfiguration({
                tenantId,
                tenantContext,
                baseUrl
            });

            res.set('Content-Type', 'application/json');
            res.set('Cache-Control', 'public, max-age=3600');
            res.json(config);
        };
    }
}

module.exports = { SmartConfigurationEndpoint };
