/**
 * PAS Inquire Operation - Check status of previously submitted PA requests
 *
 * Implements $inquire per Da Vinci PAS IG 2.1
 * Route: POST /tenants/:tenantId/4_0_0/Claim/$inquire
 */
const { logInfo, logError } = require('../../operations/common/logging');
const { generateUUID } = require('../../utils/uid.util');

class PasInquireOperation {
    /**
     * @param {Object} params
     * @param {import('../../multiTenancy/tenantDatabaseManager').TenantDatabaseManager} params.tenantDatabaseManager
     * @param {import('../../tracing/correlationIdManager').CorrelationIdManager} params.correlationIdManager
     * @param {import('../../multiTenancy/tenantService').TenantService} params.tenantService
     */
    constructor ({ tenantDatabaseManager, correlationIdManager, tenantService }) {
        this.tenantDatabaseManager = tenantDatabaseManager;
        this.correlationIdManager = correlationIdManager;
        this.tenantService = tenantService;
    }

    /**
     * Handle $inquire operation
     * @param {Object} req - Express request
     * @param {Object} res - Express response
     */
    async handle (req, res) {
        const tenantId = req.tenantId;
        const correlationId = req.correlationId;
        const startTime = Date.now();

        try {
            const inquiryBundle = req.body;

            if (!inquiryBundle || inquiryBundle.resourceType !== 'Bundle') {
                return res.status(400).json({
                    resourceType: 'OperationOutcome',
                    issue: [{
                        severity: 'error',
                        code: 'invalid',
                        diagnostics: 'Request body must be a FHIR Bundle'
                    }]
                });
            }

            // Extract the Claim Inquiry from the bundle
            const claimInquiry = inquiryBundle.entry?.find(
                e => e.resource?.resourceType === 'Claim'
            )?.resource;

            if (!claimInquiry) {
                return res.status(400).json({
                    resourceType: 'OperationOutcome',
                    issue: [{
                        severity: 'error',
                        code: 'required',
                        diagnostics: 'Bundle must contain a Claim resource for inquiry'
                    }]
                });
            }

            logInfo('PAS $inquire received', {
                tenantId,
                correlationId,
                claimId: claimInquiry.id
            });

            // Look up the original PA request in tenant DB
            const tenantContext = req.tenantContext;
            const db = await this.tenantDatabaseManager.getFhirDbForTenantAsync(tenantId, tenantContext);
            const claimsCollection = db.collection('Claim');

            // Find the original claim by reference
            const originalClaim = await claimsCollection.findOne({
                'identifier.value': claimInquiry.identifier?.[0]?.value
            });

            // Look up the most recent ClaimResponse
            const claimResponseCollection = db.collection('ClaimResponse');
            const latestResponse = await claimResponseCollection.findOne(
                { 'request.reference': originalClaim ? `Claim/${originalClaim.id}` : `Claim/${claimInquiry.id}` },
                { sort: { 'meta.lastUpdated': -1 } }
            );

            // Build inquiry response
            const inquiryResponse = {
                resourceType: 'Bundle',
                id: generateUUID(),
                type: 'collection',
                timestamp: new Date().toISOString(),
                entry: []
            };

            if (latestResponse) {
                inquiryResponse.entry.push({
                    fullUrl: `urn:uuid:${latestResponse.id}`,
                    resource: latestResponse
                });
            } else {
                // No response found, return OperationOutcome
                inquiryResponse.entry.push({
                    resource: {
                        resourceType: 'OperationOutcome',
                        issue: [{
                            severity: 'information',
                            code: 'not-found',
                            diagnostics: 'No prior authorization response found for the given inquiry'
                        }]
                    }
                });
            }

            const elapsed = Date.now() - startTime;
            logInfo('PAS $inquire completed', {
                tenantId,
                correlationId,
                elapsed: `${elapsed}ms`,
                found: !!latestResponse
            });

            res.status(200).json(inquiryResponse);
        } catch (err) {
            logError('PAS $inquire failed', { tenantId, correlationId, error: err });
            res.status(500).json({
                resourceType: 'OperationOutcome',
                issue: [{
                    severity: 'error',
                    code: 'exception',
                    diagnostics: `Internal error processing PA inquiry: ${err.message}`
                }]
            });
        }
    }
}

module.exports = { PasInquireOperation };
