import { useState } from 'react';
import {
  AUDIT_EVENT_TYPE_LIST,
  auditActorTypeSchema,
  auditTargetTypeSchema,
  type AuditActorSummary,
  type AuditEvent,
  type AuditTargetSummary,
} from '@orgistry/contracts';
import { useAuditEvents, type AuditFilters } from '../hooks/useAudit';
import {
  EmptyState,
  LoadMore,
  QueryBoundary,
} from '../components/QueryStates';
import { formatDateTime } from '../lib/format';

const ACTOR_TYPES = auditActorTypeSchema.options;
const TARGET_TYPES = auditTargetTypeSchema.options;

/**
 * Audit log reader: filterable, load-more list of the selected organization's
 * action events.
 *
 * The backend enforces `audit_events.read` (permission) and `audit_log_access`
 * (entitlement); if either is missing the list query surfaces the resulting
 * error through the standard banner. Metadata is the backend's already-sanitized
 * DTO — the UI never tries to reach past it for raw context.
 */
export function AuditPage() {
  const [filters, setFilters] = useState<AuditFilters>({});
  const { query, items, auditRetentionDays } = useAuditEvents(filters);

  function setFilter<K extends keyof AuditFilters>(
    key: K,
    value: AuditFilters[K] | undefined,
  ) {
    setFilters((current) => {
      const next = { ...current };
      if (value === undefined || value === ('' as unknown)) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  }

  return (
    <div>
      <h1 className="page-title">Audit log</h1>
      <p className="page-intro">
        Organization action events.
        {auditRetentionDays !== null && (
          <>
            {' '}
            Retention policy: <code>{auditRetentionDays}</code> day(s)
            (display-only — events are not deleted in this demo).
          </>
        )}
      </p>

      <div className="card">
        <h2>Filters</h2>
        <div className="grid-2">
          <FilterSelect
            id="filter-event-type"
            label="Event type"
            value={filters.eventType ?? ''}
            options={AUDIT_EVENT_TYPE_LIST}
            onChange={(value) =>
              setFilter('eventType', value as AuditFilters['eventType'])
            }
          />
          <FilterSelect
            id="filter-actor-type"
            label="Actor type"
            value={filters.actorType ?? ''}
            options={ACTOR_TYPES}
            onChange={(value) =>
              setFilter('actorType', value as AuditFilters['actorType'])
            }
          />
          <FilterSelect
            id="filter-target-type"
            label="Target type"
            value={filters.targetType ?? ''}
            options={TARGET_TYPES}
            onChange={(value) =>
              setFilter('targetType', value as AuditFilters['targetType'])
            }
          />
          <FilterDate
            id="filter-created-after"
            label="Created after"
            onChange={(iso) => setFilter('createdAfter', iso)}
          />
          <FilterDate
            id="filter-created-before"
            label="Created before"
            onChange={(iso) => setFilter('createdBefore', iso)}
          />
        </div>
      </div>

      <div className="card">
        <QueryBoundary isLoading={query.isLoading} error={query.error}>
          {items.length === 0 ? (
            <EmptyState>No audit events match these filters.</EmptyState>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Target</th>
                  <th>Metadata</th>
                  <th>Request</th>
                </tr>
              </thead>
              <tbody>
                {items.map((event) => (
                  <AuditRow key={event.id} event={event} />
                ))}
              </tbody>
            </table>
          )}
          <LoadMore
            hasNextPage={query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            onClick={() => query.fetchNextPage()}
          />
        </QueryBoundary>
      </div>
    </div>
  );
}

function AuditRow({ event }: { event: AuditEvent }) {
  return (
    <tr>
      <td>
        <code>{event.type}</code>
      </td>
      <td className="muted">{formatDateTime(event.createdAt)}</td>
      <td>{describeActor(event.actor)}</td>
      <td>{describeTarget(event.target)}</td>
      <td>
        <code style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {JSON.stringify(event.metadata)}
        </code>
      </td>
      <td className="muted">
        {event.requestId ? <code>{event.requestId}</code> : '—'}
      </td>
    </tr>
  );
}

function describeActor(actor: AuditActorSummary): string {
  const id = actor.userId ?? actor.apiKeyId ?? actor.membershipId;
  if (actor.label) return `${actor.type}: ${actor.label}`;
  return id ? `${actor.type} (${id})` : actor.type;
}

function describeTarget(target: AuditTargetSummary): string {
  if (target.label) return `${target.type}: ${target.label}`;
  return target.id ? `${target.type} (${target.id})` : target.type;
}

function FilterSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Any</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}

function FilterDate({
  id,
  label,
  onChange,
}: {
  id: string;
  label: string;
  onChange: (iso: string | undefined) => void;
}) {
  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="datetime-local"
        className="input"
        onChange={(event) => {
          const raw = event.target.value;
          // Convert the local datetime-local value to a full ISO-8601 instant,
          // which is what the audit filter contract requires.
          onChange(raw ? new Date(raw).toISOString() : undefined);
        }}
      />
    </div>
  );
}
