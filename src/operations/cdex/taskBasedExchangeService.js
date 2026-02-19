/**
 * TaskBasedExchangeService - Manages Task-based clinical data exchange per Da Vinci CDex IG 2.1
 *
 * Implements the CDex Task Data Request Profile for structured data exchange between
 * payers and providers. Creates and manages Task resources that represent requests
 * for clinical data, tracking their lifecycle through the following state transitions:
 *
 *   requested -> accepted -> in-progress -> completed
 *                         -> rejected
 *                         -> failed
 *
 * Integrates with the platform's notification system for task state change events,
 * enabling both payers and providers to stay informed about the progress of
 * data exchange workflows.
 *
 * @see https://build.fhir.org/ig/HL7/davinci-cdex/task-based-approach.html
 */
const { assertTypeEquals, assertIsValid } = require('../../utils/assertType');
const { TenantService } = require('../../multiTenancy/tenantService');
const { CorrelationIdManager, WORKFLOW_STAGES } = require('../../tracing/correlationIdManager');
const { logInfo, logError, logDebug } = require('../common/logging');
const { BadRequestError, NotFoundError } = require('../../utils/httpErrors');
const { generateUUID } = require('../../utils/uid.util');

/**
 * Valid CDex Task status values and their allowed transitions
 * @type {Object<string, string[]>}
 */
const TASK_STATUS_TRANSITIONS = {
    requested: ['accepted', 'rejected'],
    accepted: ['in-progress', 'cancelled'],
    'in-progress': ['completed', 'failed', 'cancelled'],
    completed: [],
    rejected: [],
    failed: [],
    cancelled: []
};

/**
 * CDex Task profile canonical URL
 * @type {string}
 */
const CDEX_TASK_DATA_REQUEST_PROFILE = 'http://hl7.org/fhir/us/davinci-cdex/StructureDefinition/cdex-task-data-request';

/**
 * CDex Task code for data request
 * @type {Object}
 */
const CDEX_TASK_CODE = {
    coding: [
        {
            system: 'http://hl7.org/fhir/us/davinci-cdex/CodeSystem/cdex-temp',
            code: 'data-request-code',
            display: 'Data Request Code'
        }
    ]
};

class TaskBasedExchangeService {
    /**
     * @typedef {Object} TaskBasedExchangeServiceParams
     * @property {TenantService} tenantService
     * @property {CorrelationIdManager} correlationIdManager
     */

    /**
     * @param {TaskBasedExchangeServiceParams} params
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
         * In-memory task state tracker for notification integration
         * In production, task state is persisted in the FHIR datastore;
         * this map tracks active tasks for efficient notification dispatch.
         * Key: taskId
         * Value: { tenantId, status, correlationId, requester, owner, lastUpdated, subscriptions }
         * @type {Map<string, Object>}
         */
        this.activeTaskTrackers = new Map();

        /**
         * Registered notification handlers for task state changes
         * @type {Array<function(Object): Promise<void>>}
         */
        this.notificationHandlers = [];

        /**
         * Maximum active tasks to track in memory
         * @type {number}
         */
        this.maxTrackedTasks = 10000;
    }

    /**
     * Create a CDex Task Data Request Profile task resource
     *
     * @param {Object} params
     * @param {string} params.tenantId - The requesting tenant (payer) ID
     * @param {string} params.correlationId - Workflow correlation ID
     * @param {string} params.requestId - Current request ID
     * @param {Object} params.requester - Reference to the requesting organization (payer)
     * @param {Object} params.owner - Reference to the task owner (provider) who will fulfill it
     * @param {Object} params.forPatient - Reference to the Patient the data is about
     * @param {Object} [params.reasonReference] - Reference to the Claim or prior auth request
     * @param {Array<Object>} params.requestedData - Array of data request input items
     * @param {string} [params.requestedData[].type] - 'code' | 'query' | 'questionnaire'
     * @param {Object} [params.requestedData[].valueCodeableConcept] - For code-based requests
     * @param {string} [params.requestedData[].valueString] - For query-based requests
     * @param {string} [params.requestedData[].valueCanonical] - For questionnaire-based requests
     * @param {string} [params.priority] - Task priority: routine | urgent | asap | stat
     * @param {string} [params.restrictionPeriodEnd] - Deadline for task completion (ISO datetime)
     * @returns {Object} A FHIR Task resource conforming to CDex Task Data Request Profile
     */
    createTaskDataRequest ({
        tenantId,
        correlationId,
        requestId,
        requester,
        owner,
        forPatient,
        reasonReference,
        requestedData,
        priority,
        restrictionPeriodEnd
    }) {
        assertIsValid(tenantId, 'tenantId is required');
        assertIsValid(correlationId, 'correlationId is required');
        assertIsValid(requester, 'requester is required');
        assertIsValid(owner, 'owner is required');
        assertIsValid(forPatient, 'forPatient is required');
        assertIsValid(requestedData && requestedData.length > 0, 'requestedData must have at least one item');

        const taskId = generateUUID();
        const now = new Date().toISOString();

        // Build input items from the requested data
        const input = requestedData.map(item => {
            const inputEntry = {
                type: {
                    coding: [
                        {
                            system: 'http://hl7.org/fhir/us/davinci-cdex/CodeSystem/cdex-temp',
                            code: item.type || 'data-code'
                        }
                    ]
                }
            };

            if (item.valueCodeableConcept) {
                inputEntry.valueCodeableConcept = item.valueCodeableConcept;
            } else if (item.valueString) {
                inputEntry.valueString = item.valueString;
            } else if (item.valueCanonical) {
                inputEntry.valueCanonical = item.valueCanonical;
            }

            return inputEntry;
        });

        // Build the Task resource
        const task = {
            resourceType: 'Task',
            id: taskId,
            meta: {
                profile: [CDEX_TASK_DATA_REQUEST_PROFILE],
                lastUpdated: now
            },
            identifier: [
                {
                    system: `urn:ietf:rfc:3986`,
                    value: `urn:uuid:${taskId}`
                }
            ],
            status: 'requested',
            intent: 'order',
            code: CDEX_TASK_CODE,
            priority: priority || 'routine',
            for: forPatient,
            authoredOn: now,
            lastModified: now,
            requester,
            owner,
            input,
            extension: [
                {
                    url: 'http://hl7.org/fhir/us/davinci-cdex/StructureDefinition/cdex-task-data-request-correlationId',
                    valueString: correlationId
                }
            ]
        };

        // Add reason reference if provided (e.g., link to Claim or prior auth)
        if (reasonReference) {
            task.reasonReference = reasonReference;
        }

        // Add restriction period if a deadline is specified
        if (restrictionPeriodEnd) {
            task.restriction = {
                period: {
                    end: restrictionPeriodEnd
                }
            };
        }

        // Track the task for notifications
        this.trackTask({
            taskId,
            tenantId,
            status: 'requested',
            correlationId,
            requestId,
            requester,
            owner,
            forPatient
        });

        logInfo('CDex Task Data Request created', {
            taskId,
            tenantId,
            correlationId,
            status: 'requested',
            inputCount: input.length,
            priority: task.priority
        });

        return task;
    }

    /**
     * Process a task status update and trigger notifications
     *
     * @param {Object} params
     * @param {string} params.taskId - The Task resource ID
     * @param {string} params.tenantId - The tenant processing this update
     * @param {string} params.newStatus - The new status to transition to
     * @param {string} params.correlationId - Workflow correlation ID
     * @param {string} params.requestId - Current request ID
     * @param {Array<Object>} [params.output] - Task output resources (for completed status)
     * @param {Object} [params.statusReason] - Reason for status change (for rejected/failed)
     * @returns {Promise<Object>} The updated task status info
     * @throws {BadRequestError} if the status transition is invalid
     * @throws {NotFoundError} if the task is not tracked
     */
    async processTaskStatusUpdateAsync ({
        taskId,
        tenantId,
        newStatus,
        correlationId,
        requestId,
        output,
        statusReason
    }) {
        assertIsValid(taskId, 'taskId is required');
        assertIsValid(newStatus, 'newStatus is required');

        const tracker = this.activeTaskTrackers.get(taskId);

        if (!tracker) {
            logDebug('Task not found in active trackers', { taskId, tenantId });
            // Task may exist in datastore but not in memory tracker; allow the update
            // but we cannot validate the transition
        }

        const currentStatus = tracker?.status;

        // Validate state transition if we have current state
        if (currentStatus) {
            const allowedTransitions = TASK_STATUS_TRANSITIONS[currentStatus];
            if (!allowedTransitions || !allowedTransitions.includes(newStatus)) {
                throw new BadRequestError(
                    new Error(
                        `Invalid Task status transition from "${currentStatus}" to "${newStatus}". ` +
                        `Allowed transitions: ${(allowedTransitions || []).join(', ') || 'none (terminal state)'}`
                    )
                );
            }
        }

        const now = new Date().toISOString();

        // Update the tracker
        if (tracker) {
            tracker.status = newStatus;
            tracker.lastUpdated = now;
            if (output) {
                tracker.output = output;
            }
            if (statusReason) {
                tracker.statusReason = statusReason;
            }
        }

        // Build notification event
        const notificationEvent = {
            eventType: 'cdex-task-status-change',
            taskId,
            tenantId,
            correlationId: correlationId || tracker?.correlationId,
            previousStatus: currentStatus || 'unknown',
            newStatus,
            timestamp: now,
            requestId,
            requester: tracker?.requester,
            owner: tracker?.owner,
            forPatient: tracker?.forPatient,
            hasOutput: !!(output && output.length > 0),
            statusReason: statusReason || null
        };

        // Dispatch notifications
        await this.dispatchNotificationsAsync(notificationEvent);

        logInfo('CDex Task status updated', {
            taskId,
            tenantId,
            previousStatus: currentStatus || 'unknown',
            newStatus,
            correlationId: correlationId || tracker?.correlationId
        });

        // Remove from tracker if terminal state
        if (TASK_STATUS_TRANSITIONS[newStatus]?.length === 0) {
            // Terminal state - schedule removal from tracker after a grace period
            setTimeout(() => {
                this.activeTaskTrackers.delete(taskId);
            }, 5 * 60 * 1000); // 5 minutes grace period for late notifications
        }

        return {
            taskId,
            previousStatus: currentStatus || 'unknown',
            newStatus,
            updatedAt: now
        };
    }

    /**
     * Track a task in the active task trackers map
     * @param {Object} taskInfo
     * @param {string} taskInfo.taskId
     * @param {string} taskInfo.tenantId
     * @param {string} taskInfo.status
     * @param {string} taskInfo.correlationId
     * @param {string} taskInfo.requestId
     * @param {Object} taskInfo.requester
     * @param {Object} taskInfo.owner
     * @param {Object} [taskInfo.forPatient]
     * @private
     */
    trackTask (taskInfo) {
        // Evict oldest entries if at capacity
        if (this.activeTaskTrackers.size >= this.maxTrackedTasks) {
            const oldestKeys = Array.from(this.activeTaskTrackers.keys()).slice(0, 100);
            oldestKeys.forEach(k => this.activeTaskTrackers.delete(k));
        }

        this.activeTaskTrackers.set(taskInfo.taskId, {
            ...taskInfo,
            lastUpdated: new Date().toISOString(),
            subscriptions: []
        });
    }

    /**
     * Register a notification handler for task state changes
     * @param {function(Object): Promise<void>} handler - Async handler function
     */
    registerNotificationHandler (handler) {
        assertIsValid(typeof handler === 'function', 'handler must be a function');
        this.notificationHandlers.push(handler);
        logInfo('CDex task notification handler registered', {
            handlerCount: this.notificationHandlers.length
        });
    }

    /**
     * Dispatch notifications to all registered handlers
     * @param {Object} event - The notification event
     * @private
     */
    async dispatchNotificationsAsync (event) {
        if (this.notificationHandlers.length === 0) {
            logDebug('No notification handlers registered for CDex task events');
            return;
        }

        const dispatchPromises = this.notificationHandlers.map(async (handler) => {
            try {
                await handler(event);
            } catch (err) {
                logError('CDex task notification handler failed', {
                    taskId: event.taskId,
                    eventType: event.eventType,
                    error: err.message
                });
            }
        });

        await Promise.allSettled(dispatchPromises);
    }

    /**
     * Get the current state of a tracked task
     * @param {string} taskId
     * @returns {Object|null}
     */
    getTaskState (taskId) {
        return this.activeTaskTrackers.get(taskId) || null;
    }

    /**
     * Get all active tasks for a tenant
     * @param {string} tenantId
     * @param {Object} [filter]
     * @param {string} [filter.status] - Filter by status
     * @param {string} [filter.correlationId] - Filter by correlation ID
     * @returns {Object[]}
     */
    getActiveTasksForTenant (tenantId, filter = {}) {
        const tasks = [];
        for (const tracker of this.activeTaskTrackers.values()) {
            if (tracker.tenantId !== tenantId) {
                continue;
            }
            if (filter.status && tracker.status !== filter.status) {
                continue;
            }
            if (filter.correlationId && tracker.correlationId !== filter.correlationId) {
                continue;
            }
            tasks.push(tracker);
        }
        return tasks;
    }

    /**
     * Validate that a Task resource conforms to the CDex Task Data Request Profile
     * @param {Object} task - A FHIR Task resource
     * @returns {{valid: boolean, errors: string[]}}
     */
    validateTaskDataRequest (task) {
        const errors = [];

        if (!task || task.resourceType !== 'Task') {
            errors.push('Resource must be a Task');
            return { valid: false, errors };
        }

        // Check profile declaration
        const hasProfile = task.meta?.profile?.includes(CDEX_TASK_DATA_REQUEST_PROFILE);
        if (!hasProfile) {
            errors.push(
                `Task.meta.profile must include "${CDEX_TASK_DATA_REQUEST_PROFILE}"`
            );
        }

        // Check required fields
        if (!task.status) {
            errors.push('Task.status is required');
        } else if (!Object.keys(TASK_STATUS_TRANSITIONS).includes(task.status)) {
            errors.push(`Task.status "${task.status}" is not a valid CDex Task status`);
        }

        if (task.intent !== 'order') {
            errors.push('Task.intent must be "order" for CDex Task Data Request');
        }

        if (!task.code?.coding?.length) {
            errors.push('Task.code is required');
        }

        if (!task.requester) {
            errors.push('Task.requester is required (the payer requesting data)');
        }

        if (!task.owner) {
            errors.push('Task.owner is required (the provider who will fulfill the request)');
        }

        if (!task.for) {
            errors.push('Task.for is required (the patient the data is about)');
        }

        if (!task.input || task.input.length === 0) {
            errors.push('Task.input must contain at least one data request item');
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    /**
     * Build an AuditEvent for a CDex task-based exchange operation
     * @param {Object} params
     * @param {string} params.tenantId
     * @param {string} params.correlationId
     * @param {string} params.requestId
     * @param {string} params.taskId
     * @param {string} params.action - 'create' | 'update-status' | 'complete'
     * @param {string} [params.previousStatus]
     * @param {string} [params.newStatus]
     * @param {string} params.outcome - 'success' | 'error'
     * @param {string} [params.outcomeDesc]
     * @returns {Object} FHIR AuditEvent resource
     */
    buildAuditEvent ({
        tenantId,
        correlationId,
        requestId,
        taskId,
        action,
        previousStatus,
        newStatus,
        outcome,
        outcomeDesc
    }) {
        const now = new Date().toISOString();
        return {
            resourceType: 'AuditEvent',
            type: {
                system: 'http://dicom.nema.org/resources/ontology/DCM',
                code: action === 'create' ? '110110' : '110112',
                display: action === 'create' ? 'Patient Record' : 'Query'
            },
            subtype: [
                {
                    system: 'http://hl7.org/fhir/us/davinci-cdex',
                    code: 'task-based-exchange',
                    display: 'CDex Task-Based Exchange'
                }
            ],
            action: action === 'create' ? 'C' : 'U',
            period: {
                start: now
            },
            recorded: now,
            outcome: outcome === 'success' ? '0' : '8',
            outcomeDesc: outcomeDesc || `CDex Task ${action} ${outcome}`,
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
                    display: 'FHIR Server CDex Operations'
                }
            },
            entity: [
                {
                    what: {
                        reference: `Task/${taskId}`
                    },
                    type: {
                        system: 'http://terminology.hl7.org/CodeSystem/audit-entity-type',
                        code: '2',
                        display: 'System Object'
                    },
                    detail: [
                        { type: 'correlationId', valueString: correlationId },
                        { type: 'requestId', valueString: requestId },
                        { type: 'workflowStage', valueString: WORKFLOW_STAGES.CDEX_TASK_EXCHANGE },
                        { type: 'tenantId', valueString: tenantId },
                        { type: 'taskAction', valueString: action },
                        ...(previousStatus
                            ? [{ type: 'previousStatus', valueString: previousStatus }]
                            : []),
                        ...(newStatus
                            ? [{ type: 'newStatus', valueString: newStatus }]
                            : [])
                    ]
                }
            ]
        };
    }
}

module.exports = {
    TaskBasedExchangeService,
    TASK_STATUS_TRANSITIONS,
    CDEX_TASK_DATA_REQUEST_PROFILE,
    CDEX_TASK_CODE
};
