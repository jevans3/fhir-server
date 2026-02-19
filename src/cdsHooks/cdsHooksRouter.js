/**
 * CDS Hooks Router - Express router for CDS Hooks 2.0 endpoints
 *
 * Provides the CDS Hooks discovery and service invocation endpoints
 * scoped to a tenant context for multi-tenant B2B prior authorization.
 *
 * Routes:
 *   GET  /tenants/:tenantId/cds-services          - Discovery endpoint
 *   POST /tenants/:tenantId/cds-services/:serviceId - Hook invocation endpoint
 *
 * Per CDS Hooks 2.0 specification: https://cds-hooks.hl7.org/2.0/
 */
const express = require('express');
const { CdsHooksService } = require('./cdsHooksService');
const { assertTypeEquals } = require('../utils/assertType');
const { TenantConfigManager } = require('../multiTenancy/tenantConfigManager');
const { logInfo, logError } = require('../operations/common/logging');

/**
 * Supported CDS hooks and their service definitions.
 * These correspond to CRD hooks defined in the Da Vinci CRD IG.
 * @type {Object[]}
 */
const CDS_SERVICE_DEFINITIONS = [
    {
        hook: 'order-sign',
        id: 'crd-order-sign',
        title: 'Coverage Requirements Discovery - Order Sign',
        description: 'Evaluates coverage requirements when a practitioner signs an order. ' +
            'Returns cards indicating prior authorization requirements, documentation needs, ' +
            'and appropriate next steps per the Da Vinci CRD Implementation Guide.',
        prefetch: {
            patient: 'Patient/{{context.patientId}}',
            encounter: 'Encounter?_id={{context.encounterId}}',
            coverage: 'Coverage?patient={{context.patientId}}&status=active',
            serviceRequest: 'ServiceRequest?_id={{context.draftOrders.ServiceRequest.id}}'
        }
    },
    {
        hook: 'order-select',
        id: 'crd-order-select',
        title: 'Coverage Requirements Discovery - Order Select',
        description: 'Evaluates coverage requirements when a practitioner selects an order. ' +
            'Provides early feedback on prior authorization requirements before the order is signed.',
        prefetch: {
            patient: 'Patient/{{context.patientId}}',
            coverage: 'Coverage?patient={{context.patientId}}&status=active'
        }
    },
    {
        hook: 'order-dispatch',
        id: 'crd-order-dispatch',
        title: 'Coverage Requirements Discovery - Order Dispatch',
        description: 'Evaluates coverage requirements when an order is dispatched to a performer.',
        prefetch: {
            patient: 'Patient/{{context.patientId}}',
            coverage: 'Coverage?patient={{context.patientId}}&status=active',
            serviceRequest: 'ServiceRequest?_id={{context.order}}'
        }
    },
    {
        hook: 'appointment-book',
        id: 'crd-appointment-book',
        title: 'Coverage Requirements Discovery - Appointment Book',
        description: 'Evaluates coverage requirements when an appointment is being booked.',
        prefetch: {
            patient: 'Patient/{{context.patientId}}',
            coverage: 'Coverage?patient={{context.patientId}}&status=active'
        }
    },
    {
        hook: 'encounter-start',
        id: 'crd-encounter-start',
        title: 'Coverage Requirements Discovery - Encounter Start',
        description: 'Evaluates coverage requirements at the start of an encounter.',
        prefetch: {
            patient: 'Patient/{{context.patientId}}',
            coverage: 'Coverage?patient={{context.patientId}}&status=active',
            encounter: 'Encounter?_id={{context.encounterId}}'
        }
    },
    {
        hook: 'encounter-discharge',
        id: 'crd-encounter-discharge',
        title: 'Coverage Requirements Discovery - Encounter Discharge',
        description: 'Evaluates coverage requirements at encounter discharge.',
        prefetch: {
            patient: 'Patient/{{context.patientId}}',
            coverage: 'Coverage?patient={{context.patientId}}&status=active',
            encounter: 'Encounter?_id={{context.encounterId}}'
        }
    }
];

/**
 * @typedef CdsHooksRouterProps
 * @property {CdsHooksService} cdsHooksService
 * @property {TenantConfigManager} tenantConfigManager
 */

class CdsHooksRouter {
    /**
     * @param {CdsHooksRouterProps} params
     */
    constructor ({ cdsHooksService, tenantConfigManager }) {
        /** @type {CdsHooksService} */
        this.cdsHooksService = cdsHooksService;
        assertTypeEquals(cdsHooksService, CdsHooksService);

        /** @type {TenantConfigManager} */
        this.tenantConfigManager = tenantConfigManager;
        assertTypeEquals(tenantConfigManager, TenantConfigManager);
    }

    /**
     * Creates and returns the Express router with CDS Hooks routes.
     * Authentication and tenant middleware should be applied externally
     * before this router is mounted.
     * @returns {import('express').Router}
     */
    getRouter () {
        const router = express.Router({ mergeParams: true });

        // Parse JSON bodies for CDS Hooks requests
        router.use(express.json({ type: ['application/json', 'application/fhir+json'] }));

        // Discovery endpoint - returns available CDS services for this tenant
        router.get(
            '/tenants/:tenantId/cds-services',
            this.handleDiscovery.bind(this)
        );

        // Hook invocation endpoint - processes a CDS hook call
        router.post(
            '/tenants/:tenantId/cds-services/:serviceId',
            this.handleHookInvocation.bind(this)
        );

        return router;
    }

    /**
     * Handles the CDS Hooks discovery endpoint.
     * Returns the list of CDS services available for the tenant.
     *
     * Per CDS Hooks 2.0 Section 2: Discovery
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @returns {Promise<void>}
     */
    async handleDiscovery (req, res) {
        try {
            const { tenantId } = req.params;
            const tenantContext = req.tenantContext;

            if (!tenantContext) {
                return res.status(400).json({
                    resourceType: 'OperationOutcome',
                    issue: [{
                        severity: 'error',
                        code: 'required',
                        diagnostics: 'Tenant context is required for CDS Hooks discovery'
                    }]
                });
            }

            // Check if CRD is enabled for this tenant
            if (!tenantContext.isFeatureEnabled('crdEnabled')) {
                return res.status(403).json({
                    resourceType: 'OperationOutcome',
                    issue: [{
                        severity: 'error',
                        code: 'forbidden',
                        diagnostics: `CRD is not enabled for tenant '${tenantId}'`
                    }]
                });
            }

            // Filter services based on tenant configuration
            const enabledServices = this.getEnabledServicesForTenant(tenantContext);

            logInfo('CDS Hooks discovery', {
                tenantId,
                serviceCount: enabledServices.length,
                correlationId: req.correlationId
            });

            return res.status(200).json({
                services: enabledServices
            });
        } catch (err) {
            logError('CDS Hooks discovery failed', {
                error: err,
                tenantId: req.params.tenantId,
                correlationId: req.correlationId
            });

            return res.status(500).json({
                resourceType: 'OperationOutcome',
                issue: [{
                    severity: 'error',
                    code: 'exception',
                    diagnostics: 'Internal error processing CDS Hooks discovery request'
                }]
            });
        }
    }

    /**
     * Handles a CDS hook invocation.
     * Validates the request, processes it through the CDS Hooks service,
     * and returns CDS Cards.
     *
     * Per CDS Hooks 2.0 Section 3: Calling a CDS Service
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @returns {Promise<void>}
     */
    async handleHookInvocation (req, res) {
        try {
            const { tenantId, serviceId } = req.params;
            const tenantContext = req.tenantContext;

            if (!tenantContext) {
                return res.status(400).json({
                    resourceType: 'OperationOutcome',
                    issue: [{
                        severity: 'error',
                        code: 'required',
                        diagnostics: 'Tenant context is required for CDS Hooks invocation'
                    }]
                });
            }

            // Check if CRD is enabled for this tenant
            if (!tenantContext.isFeatureEnabled('crdEnabled')) {
                return res.status(403).json({
                    resourceType: 'OperationOutcome',
                    issue: [{
                        severity: 'error',
                        code: 'forbidden',
                        diagnostics: `CRD is not enabled for tenant '${tenantId}'`
                    }]
                });
            }

            // Validate the service ID is recognized
            const serviceDefinition = CDS_SERVICE_DEFINITIONS.find(s => s.id === serviceId);
            if (!serviceDefinition) {
                return res.status(404).json({
                    resourceType: 'OperationOutcome',
                    issue: [{
                        severity: 'error',
                        code: 'not-found',
                        diagnostics: `CDS service '${serviceId}' not found`
                    }]
                });
            }

            // Delegate to the CDS Hooks service for processing
            const result = await this.cdsHooksService.processHookRequestAsync({
                hookRequest: req.body,
                serviceId,
                serviceDefinition,
                tenantContext,
                correlationId: req.correlationId,
                requestId: req.id
            });

            logInfo('CDS hook invocation completed', {
                tenantId,
                serviceId,
                hook: serviceDefinition.hook,
                cardCount: result.cards ? result.cards.length : 0,
                correlationId: req.correlationId
            });

            // Return CDS Hooks 2.0 response format
            return res.status(200).json({
                cards: result.cards || [],
                systemActions: result.systemActions || [],
                ...(result.extension ? { extension: result.extension } : {})
            });
        } catch (err) {
            logError('CDS hook invocation failed', {
                error: err,
                tenantId: req.params.tenantId,
                serviceId: req.params.serviceId,
                correlationId: req.correlationId
            });

            return res.status(500).json({
                resourceType: 'OperationOutcome',
                issue: [{
                    severity: 'error',
                    code: 'exception',
                    diagnostics: 'Internal error processing CDS hook request'
                }]
            });
        }
    }

    /**
     * Filters the available CDS service definitions based on the tenant's
     * enabled features and connected payer configuration.
     * @param {import('../multiTenancy/tenantContext').TenantContext} tenantContext
     * @returns {Object[]} Filtered service definitions
     */
    getEnabledServicesForTenant (tenantContext) {
        // Start with all service definitions
        let services = [...CDS_SERVICE_DEFINITIONS];

        // If the tenant has specific hook configuration, filter accordingly
        const hookConfig = tenantContext.features.crdHooks;
        if (hookConfig && Array.isArray(hookConfig)) {
            services = services.filter(s => hookConfig.includes(s.hook));
        }

        // Add tenant-specific metadata to each service
        return services.map(service => ({
            ...service,
            extension: {
                'davinci-crd.configuration': {
                    tenantId: tenantContext.tenantId,
                    payerCount: tenantContext.connectedPayers
                        ? tenantContext.connectedPayers.length
                        : 0
                }
            }
        }));
    }
}

module.exports = {
    CdsHooksRouter,
    CDS_SERVICE_DEFINITIONS
};
