/**
 * AuditEventBuilder - Fluent builder for FHIR R4 AuditEvent resources
 *
 * Constructs properly structured FHIR R4 AuditEvent JSON following
 * CMS-0057-F compliance requirements for prior authorization workflows.
 *
 * Usage:
 *   const event = new AuditEventBuilder()
 *     .withType({ system: 'http://dicom.nema.org/resources/ontology/DCM', code: '110112', display: 'Query' })
 *     .withAction('R')
 *     .withAgent({ who: 'Practitioner/123', requestor: true })
 *     .withSource({ site: 'tenant-acme', observer: 'Device/fhir-platform' })
 *     .withEntity({ what: 'Claim/456', type: 'Claim' })
 *     .withCorrelation({ correlationId: 'abc-123', workflowStage: 'PAS-submit' })
 *     .withTenant({ tenantId: 'acme', tenantName: 'Acme Health' })
 *     .build();
 */
const { generateUUID } = require('../utils/uid.util');

/**
 * Valid FHIR AuditEvent action codes per http://hl7.org/fhir/audit-event-action
 * @readonly
 * @enum {string}
 */
const AUDIT_ACTION_CODES = {
    CREATE: 'C',
    READ: 'R',
    UPDATE: 'U',
    DELETE: 'D',
    EXECUTE: 'E'
};

/**
 * Standard AuditEvent type codes from DICOM (DCM) code system
 * @readonly
 * @enum {{system: string, code: string, display: string}}
 */
const AUDIT_TYPE_CODES = {
    APPLICATION_ACTIVITY: {
        system: 'http://dicom.nema.org/resources/ontology/DCM',
        code: '110100',
        display: 'Application Activity'
    },
    AUDIT_LOG_USED: {
        system: 'http://dicom.nema.org/resources/ontology/DCM',
        code: '110101',
        display: 'Audit Log Used'
    },
    IMPORT: {
        system: 'http://dicom.nema.org/resources/ontology/DCM',
        code: '110107',
        display: 'Import'
    },
    EXPORT: {
        system: 'http://dicom.nema.org/resources/ontology/DCM',
        code: '110106',
        display: 'Export'
    },
    QUERY: {
        system: 'http://dicom.nema.org/resources/ontology/DCM',
        code: '110112',
        display: 'Query'
    },
    ORDER_RECORD: {
        system: 'http://dicom.nema.org/resources/ontology/DCM',
        code: '110108',
        display: 'Order Record'
    },
    PATIENT_RECORD: {
        system: 'http://dicom.nema.org/resources/ontology/DCM',
        code: '110110',
        display: 'Patient Record'
    },
    REST: {
        system: 'http://terminology.hl7.org/CodeSystem/audit-event-type',
        code: 'rest',
        display: 'RESTful Operation'
    }
};

/**
 * FHIR RESTful interaction subtypes
 * @readonly
 * @enum {{system: string, code: string, display: string}}
 */
const AUDIT_SUBTYPE_CODES = {
    CREATE: {
        system: 'http://hl7.org/fhir/restful-interaction',
        code: 'create',
        display: 'create'
    },
    READ: {
        system: 'http://hl7.org/fhir/restful-interaction',
        code: 'read',
        display: 'read'
    },
    UPDATE: {
        system: 'http://hl7.org/fhir/restful-interaction',
        code: 'update',
        display: 'update'
    },
    DELETE: {
        system: 'http://hl7.org/fhir/restful-interaction',
        code: 'delete',
        display: 'delete'
    },
    SEARCH: {
        system: 'http://hl7.org/fhir/restful-interaction',
        code: 'search',
        display: 'search'
    },
    VREAD: {
        system: 'http://hl7.org/fhir/restful-interaction',
        code: 'vread',
        display: 'vread'
    },
    HISTORY: {
        system: 'http://hl7.org/fhir/restful-interaction',
        code: 'history',
        display: 'history'
    },
    OPERATION: {
        system: 'http://hl7.org/fhir/restful-interaction',
        code: 'operation',
        display: 'operation'
    },
    BATCH: {
        system: 'http://hl7.org/fhir/restful-interaction',
        code: 'batch',
        display: 'batch'
    },
    TRANSACTION: {
        system: 'http://hl7.org/fhir/restful-interaction',
        code: 'transaction',
        display: 'transaction'
    }
};

/**
 * AuditEvent outcome codes per http://hl7.org/fhir/audit-event-outcome
 * @readonly
 * @enum {string}
 */
const AUDIT_OUTCOME_CODES = {
    SUCCESS: '0',
    MINOR_FAILURE: '4',
    SERIOUS_FAILURE: '8',
    MAJOR_FAILURE: '12'
};

/**
 * AuditEvent source type codes
 * @readonly
 * @enum {{system: string, code: string, display: string}}
 */
const AUDIT_SOURCE_TYPE_CODES = {
    APPLICATION_SERVER: {
        system: 'http://terminology.hl7.org/CodeSystem/security-source-type',
        code: '4',
        display: 'Application Server'
    }
};

/**
 * AuditEvent entity type codes
 * @readonly
 * @enum {{system: string, code: string, display: string}}
 */
const AUDIT_ENTITY_TYPE_CODES = {
    PERSON: {
        system: 'http://terminology.hl7.org/CodeSystem/audit-entity-type',
        code: '1',
        display: 'Person'
    },
    SYSTEM_OBJECT: {
        system: 'http://terminology.hl7.org/CodeSystem/audit-entity-type',
        code: '2',
        display: 'System Object'
    }
};

/**
 * AuditEvent entity role codes
 * @readonly
 * @enum {{system: string, code: string, display: string}}
 */
const AUDIT_ENTITY_ROLE_CODES = {
    PATIENT: {
        system: 'http://terminology.hl7.org/CodeSystem/object-role',
        code: '1',
        display: 'Patient'
    },
    QUERY: {
        system: 'http://terminology.hl7.org/CodeSystem/object-role',
        code: '24',
        display: 'Query'
    },
    JOB: {
        system: 'http://terminology.hl7.org/CodeSystem/object-role',
        code: '20',
        display: 'Job'
    },
    DOMAIN_RESOURCE: {
        system: 'http://terminology.hl7.org/CodeSystem/object-role',
        code: '4',
        display: 'Domain Resource'
    }
};

/**
 * Correlation tracking extension URL
 * @type {string}
 */
const CORRELATION_EXTENSION_URL = 'https://fhir.icanbwell.com/4_0_0/StructureDefinition/correlation-tracking';

class AuditEventBuilder {
    constructor () {
        /**
         * Internal FHIR AuditEvent resource being built
         * @type {Object}
         * @private
         */
        this._resource = {
            resourceType: 'AuditEvent',
            id: generateUUID(),
            meta: {
                versionId: '1',
                lastUpdated: new Date().toISOString()
            },
            recorded: new Date().toISOString(),
            agent: [],
            entity: [],
            extension: []
        };
    }

    /**
     * Set the AuditEvent type (e.g., DCM code for the category of event)
     * @param {Object} params
     * @param {string} params.system - Code system URI (e.g., 'http://dicom.nema.org/resources/ontology/DCM')
     * @param {string} params.code - Type code (e.g., '110112' for Query)
     * @param {string} params.display - Human-readable display text
     * @returns {AuditEventBuilder} this builder for chaining
     */
    withType ({ system, code, display }) {
        this._resource.type = { system, code, display };
        return this;
    }

    /**
     * Set the AuditEvent subtype (e.g., FHIR RESTful interaction type)
     * @param {Object[]} subtypes - Array of subtype coding objects
     * @param {string} subtypes[].system - Code system URI
     * @param {string} subtypes[].code - Subtype code
     * @param {string} subtypes[].display - Human-readable display text
     * @returns {AuditEventBuilder} this builder for chaining
     */
    withSubtype (subtypes) {
        this._resource.subtype = Array.isArray(subtypes) ? subtypes : [subtypes];
        return this;
    }

    /**
     * Set the action code (C/R/U/D/E)
     * @param {string} action - One of 'C', 'R', 'U', 'D', 'E'
     * @returns {AuditEventBuilder} this builder for chaining
     */
    withAction (action) {
        const validActions = Object.values(AUDIT_ACTION_CODES);
        if (!validActions.includes(action)) {
            throw new Error(`Invalid action code '${action}'. Must be one of: ${validActions.join(', ')}`);
        }
        this._resource.action = action;
        return this;
    }

    /**
     * Set the event period (start/end timestamps)
     * @param {Object} params
     * @param {string|Date} params.start - Period start timestamp
     * @param {string|Date} [params.end] - Period end timestamp
     * @returns {AuditEventBuilder} this builder for chaining
     */
    withPeriod ({ start, end }) {
        this._resource.period = {
            start: start instanceof Date ? start.toISOString() : start
        };
        if (end) {
            this._resource.period.end = end instanceof Date ? end.toISOString() : end;
        }
        return this;
    }

    /**
     * Set the recorded timestamp (when the event was logged)
     * @param {string|Date} recorded - The timestamp
     * @returns {AuditEventBuilder} this builder for chaining
     */
    withRecorded (recorded) {
        this._resource.recorded = recorded instanceof Date ? recorded.toISOString() : recorded;
        return this;
    }

    /**
     * Set the outcome code
     * @param {string} outcome - One of '0' (success), '4' (minor failure), '8' (serious failure), '12' (major failure)
     * @param {string} [outcomeDesc] - Human-readable outcome description
     * @returns {AuditEventBuilder} this builder for chaining
     */
    withOutcome (outcome, outcomeDesc) {
        this._resource.outcome = outcome;
        if (outcomeDesc) {
            this._resource.outcomeDesc = outcomeDesc;
        }
        return this;
    }

    /**
     * Add an agent (actor) to the AuditEvent
     * @param {Object} params
     * @param {string} params.who - Reference to the agent (e.g., 'Practitioner/123')
     * @param {boolean} params.requestor - Whether this agent initiated the event
     * @param {string} [params.altId] - Alternative user identity
     * @param {string} [params.name] - Human-readable name of agent
     * @param {Object} [params.type] - Agent type coding
     * @param {Object} [params.network] - Network access point info
     * @param {string} [params.network.address] - Network address (IP or hostname)
     * @param {string} [params.network.type] - Network type code ('1'=machine name, '2'=IP address)
     * @param {Object[]} [params.role] - Agent role coding array
     * @returns {AuditEventBuilder} this builder for chaining
     */
    withAgent ({ who, requestor, altId, name, type, network, role }) {
        const agent = {
            who: typeof who === 'string' ? { reference: who } : who,
            requestor: requestor === true
        };

        if (altId) {
            agent.altId = altId;
        }
        if (name) {
            agent.name = name;
        }
        if (type) {
            agent.type = type;
        }
        if (network) {
            agent.network = {
                address: network.address,
                type: network.type || '2'
            };
        }
        if (role) {
            agent.role = Array.isArray(role) ? role : [role];
        }

        this._resource.agent.push(agent);
        return this;
    }

    /**
     * Set the audit event source
     * @param {Object} params
     * @param {string} [params.site] - Tenant name or logical source site
     * @param {string} params.observer - Reference to the observer (e.g., 'Device/fhir-platform')
     * @param {Object[]} [params.type] - Source type coding array
     * @returns {AuditEventBuilder} this builder for chaining
     */
    withSource ({ site, observer, type }) {
        this._resource.source = {
            observer: typeof observer === 'string' ? { reference: observer } : observer
        };

        if (site) {
            this._resource.source.site = site;
        }
        if (type) {
            this._resource.source.type = Array.isArray(type) ? type : [type];
        }

        return this;
    }

    /**
     * Add an entity (affected resource) to the AuditEvent
     * @param {Object} params
     * @param {string} params.what - Reference to the entity (e.g., 'Claim/456')
     * @param {Object} [params.type] - Entity type coding
     * @param {Object} [params.role] - Entity role coding
     * @param {string} [params.name] - Entity descriptor/name
     * @param {Array<{type: string, valueString: string}>} [params.detail] - Additional detail key-value pairs
     * @returns {AuditEventBuilder} this builder for chaining
     */
    withEntity ({ what, type, role, name, detail }) {
        const entity = {
            what: typeof what === 'string' ? { reference: what } : what
        };

        if (type) {
            entity.type = type;
        }
        if (role) {
            entity.role = role;
        }
        if (name) {
            entity.name = name;
        }
        if (detail && detail.length > 0) {
            entity.detail = detail;
        }

        this._resource.entity.push(entity);
        return this;
    }

    /**
     * Add correlation tracking extension for end-to-end workflow tracing
     * @param {Object} params
     * @param {string} params.correlationId - The correlation ID linking workflow stages
     * @param {string} [params.traceId] - OpenTelemetry trace ID
     * @param {string} [params.spanId] - OpenTelemetry span ID
     * @param {string} [params.workflowStage] - Current workflow stage (e.g., 'PAS-submit')
     * @param {string} [params.parentCorrelationId] - Parent correlation ID for nested workflows
     * @returns {AuditEventBuilder} this builder for chaining
     */
    withCorrelation ({ correlationId, traceId, spanId, workflowStage, parentCorrelationId }) {
        const extensions = [];

        if (correlationId) {
            extensions.push({
                url: `${CORRELATION_EXTENSION_URL}/correlationId`,
                valueString: correlationId
            });
        }
        if (traceId) {
            extensions.push({
                url: `${CORRELATION_EXTENSION_URL}/traceId`,
                valueString: traceId
            });
        }
        if (spanId) {
            extensions.push({
                url: `${CORRELATION_EXTENSION_URL}/spanId`,
                valueString: spanId
            });
        }
        if (workflowStage) {
            extensions.push({
                url: `${CORRELATION_EXTENSION_URL}/workflowStage`,
                valueString: workflowStage
            });
        }
        if (parentCorrelationId) {
            extensions.push({
                url: `${CORRELATION_EXTENSION_URL}/parentCorrelationId`,
                valueString: parentCorrelationId
            });
        }

        if (extensions.length > 0) {
            this._resource.extension.push({
                url: CORRELATION_EXTENSION_URL,
                extension: extensions
            });
        }

        return this;
    }

    /**
     * Add tenant context metadata to the AuditEvent meta tags
     * @param {Object} params
     * @param {string} params.tenantId - Tenant identifier
     * @param {string} [params.tenantName] - Tenant display name
     * @returns {AuditEventBuilder} this builder for chaining
     */
    withTenant ({ tenantId, tenantName }) {
        if (!this._resource.meta.security) {
            this._resource.meta.security = [];
        }

        this._resource.meta.security.push({
            system: 'https://www.icanbwell.com/owner',
            code: tenantId
        });
        this._resource.meta.security.push({
            system: 'https://www.icanbwell.com/access',
            code: tenantId
        });

        if (tenantName) {
            this._resource.meta.tag = this._resource.meta.tag || [];
            this._resource.meta.tag.push({
                system: 'https://www.icanbwell.com/tenant',
                code: tenantId,
                display: tenantName
            });
        }

        return this;
    }

    /**
     * Set the meta security tags directly (owner, access, vendor, etc.)
     * @param {Array<{system: string, code: string, display?: string}>} securityTags
     * @returns {AuditEventBuilder} this builder for chaining
     */
    withMetaSecurity (securityTags) {
        this._resource.meta.security = securityTags;
        return this;
    }

    /**
     * Set purpose of event (purposeOfEvent codeable concept array)
     * @param {Array<{coding: Array<{system: string, code: string, display: string}>}>} purposes
     * @returns {AuditEventBuilder} this builder for chaining
     */
    withPurposeOfEvent (purposes) {
        this._resource.purposeOfEvent = purposes;
        return this;
    }

    /**
     * Build and return the complete FHIR R4 AuditEvent resource
     * @returns {Object} A properly structured FHIR R4 AuditEvent JSON object
     * @throws {Error} If required fields (type, recorded, agent, source) are missing
     */
    build () {
        // Validate required fields per FHIR R4 AuditEvent spec
        if (!this._resource.type) {
            throw new Error('AuditEvent requires a type. Call withType() before build().');
        }
        if (!this._resource.recorded) {
            throw new Error('AuditEvent requires a recorded timestamp. Call withRecorded() before build().');
        }
        if (!this._resource.agent || this._resource.agent.length === 0) {
            throw new Error('AuditEvent requires at least one agent. Call withAgent() before build().');
        }
        if (!this._resource.source) {
            throw new Error('AuditEvent requires a source. Call withSource() before build().');
        }

        // Clean up empty arrays
        if (this._resource.extension && this._resource.extension.length === 0) {
            delete this._resource.extension;
        }
        if (this._resource.entity && this._resource.entity.length === 0) {
            delete this._resource.entity;
        }

        // Return a deep copy to prevent external mutation
        return JSON.parse(JSON.stringify(this._resource));
    }
}

module.exports = {
    AuditEventBuilder,
    AUDIT_ACTION_CODES,
    AUDIT_TYPE_CODES,
    AUDIT_SUBTYPE_CODES,
    AUDIT_OUTCOME_CODES,
    AUDIT_SOURCE_TYPE_CODES,
    AUDIT_ENTITY_TYPE_CODES,
    AUDIT_ENTITY_ROLE_CODES,
    CORRELATION_EXTENSION_URL
};
