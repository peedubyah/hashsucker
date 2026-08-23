import type { OperatorHealth as OperatorHealthType } from '@/types/api';

interface Props {
  health: OperatorHealthType;
}

export function OperatorHealth({ health }: Props) {
  const { checks } = health;

  return (
    <div className="operator-health">
      <h2>System Status</h2>

      <div className="health-grid">
        <HealthCard
          name={checks.database.name}
          status={checks.database.status}
          detail={checks.database.detail}
        />
        <HealthCard
          name={checks.worker.name}
          status={checks.worker.status}
          detail={checks.worker.detail}
        />
        <HealthCard
          name={checks.storage.name}
          status={checks.storage.status}
          detail={checks.storage.detail}
        />
      </div>

      {checks.database.byState && (
        <div className="health-breakdown">
          <h3>Active Work</h3>
          <table className="health-table">
            <tbody>
              {Object.entries(checks.database.byState).map(([state, count]) => (
                <tr key={state}>
                  <td>{state}</td>
                  <td className="num">{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function HealthCard({ name, status, detail }: { name: string; status: string; detail: string }) {
  const statusClass = status === 'ok' ? 'ok' : status === 'warning' ? 'warning' : 'error';
  const statusIcon = status === 'ok' ? '✓' : status === 'warning' ? '⚠' : '✗';

  return (
    <div className={`health-card ${statusClass}`}>
      <div className="health-card-header">
        <span className="health-status-icon">{statusIcon}</span>
        <span className="health-card-name">{name}</span>
      </div>
      <div className="health-card-detail">{detail}</div>
    </div>
  );
}
