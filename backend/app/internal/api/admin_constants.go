package api

// ADMIN CONSTANTS: shared status, audit, and default value constants for admin handlers.
// Eliminates hardcoded strings across admin_new.go and admin_pending.go.

// ---------------------------------------------------------------------------
// Status constants
// ---------------------------------------------------------------------------

const (
	StatusActive    = "active"
	StatusSuspended = "suspended"
	StatusPending   = "pending"
	StatusClosed    = "closed"
	StatusCancelled = "cancelled"
	StatusSent      = "sent"
	StatusOpen      = "open"
	StatusResolved  = "resolved"
	StatusEscalated = "escalated"
	StatusDraft     = "draft"
	StatusPublished = "published"
	StatusArchived  = "archived"
)

// Ticket statuses
const (
	TicketStatusOpen       = "open"
	TicketStatusAssigned   = "assigned"
	TicketStatusInProgress = "in_progress"
	TicketStatusResolved   = "resolved"
	TicketStatusClosed     = "closed"
)

// Ticket priorities
const (
	TicketPriorityLow      = "low"
	TicketPriorityNormal   = "normal"
	TicketPriorityHigh     = "high"
	TicketPriorityCritical = "critical"
)

// Handoff statuses
const (
	HandoffStatusPending    = "pending"
	HandoffStatusResolved   = "resolved"
	HandoffStatusSealBroken = "seal_broken"
)

// Payroll statuses
const (
	PayrollStatusPending  = "pending"
	PayrollStatusRunning  = "running"
	PayrollStatusComplete = "complete"
	PayrollStatusFailed   = "failed"
)

// ---------------------------------------------------------------------------
// Audit event type constants
// ---------------------------------------------------------------------------

const (
	AuditPasswordReset           = "password.reset"
	AuditPayrollBatchCreated     = "payroll.batch_created"
	AuditConfigUpdated           = "configuration.updated"
	AuditAdminCreated            = "admin.created"
	AuditAdminUpdated            = "admin.updated"
	AuditAdminSuspended          = "admin.suspended"
	AuditTeamCreated             = "team.created"
	AuditTeamDeleted             = "team.deleted"
	AuditPolicyCreated           = "policy.created"
	AuditNotificationCancelled   = "notification.cancelled"
	AuditSettingsUpdated         = "settings.updated"
	AuditContentStateUpdated     = "content.state_updated"
	AuditContentCreated          = "content.created"
	AuditReportCreated           = "report.created"
	AuditTicketReplied           = "ticket.replied"
	AuditTicketEscalated         = "ticket.escalated"
	AuditTicketClosed            = "ticket.closed"
	AuditTicketTransferred       = "ticket.transferred"
	AuditHandoffSealResealed     = "handoff.seal_resealed"
	AuditHandoffSealDamageClaim  = "handoff.seal_damage_claim"
	AuditDisputeDecided          = "dispute.decided"
	AuditOrderCancelled          = "order.cancelled"
	AuditPayoutReconciled        = "payout.reconciled"
	AuditCODReconciled           = "cod.reconciled"
	AuditChainOnboarded          = "chain.onboarded"
	AuditChainSuspended          = "chain.suspended"
	AuditDataExportDecided       = "data_export.decided"
	AuditDataExportRerun         = "data_export.rerun"
	AuditLoyaltyConfigUpdated    = "loyalty.updated"
	AuditCrashResponded          = "crash.responded"
	AuditRiderRestOverride       = "rider.rest_override"
	AuditConsignmentMissingDec   = "consignment.missing_decision"
	AuditRiderApprovalDecided    = "rider.approval_decided"
	AuditProviderApprovalDecided = "provider.approval_decided"
	AuditLogisticsAnomalyDecided = "logistics.anomaly_decided"
)

// ---------------------------------------------------------------------------
// Audit entity type constants
// ---------------------------------------------------------------------------

const (
	EntityUser          = "user"
	EntityAdminUser     = "admin_user"
	EntityTeam          = "team"
	EntityPolicy        = "policy"
	EntityConfig        = "admin_config"
	EntityPayrollBatch  = "payroll_batch"
	EntityNotification  = "notification"
	EntitySettings      = "settings"
	EntityContent       = "content"
	EntityReport        = "report"
	EntityTicket        = "ticket"
	EntityHandoff       = "handoff"
	EntityDispute       = "dispute"
	EntityOrder         = "order"
	EntityPayoutBatch   = "payout_batch"
	EntityCODSession    = "cod_session"
	EntityChainAccount  = "chain_account"
	EntityDataExport    = "data_export"
	EntitySafetyEvent   = "safety_event"
	EntityConsignment   = "consignment"
	EntityRider         = "rider"
	EntityProvider      = "provider"
	EntityLogisticsAnom = "logistics_anomaly"
	EntityLoyaltyConfig = "loyalty_config"
)

// ---------------------------------------------------------------------------
// Default configuration values
// ---------------------------------------------------------------------------
