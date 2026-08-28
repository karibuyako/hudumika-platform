import { useState } from 'react'

type Slot = { day: string; start: string; end: string; enabled: boolean }

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

export function AvailabilityPage() {
  const [slots, setSlots] = useState<Slot[]>(() =>
    DAYS.map((day) => ({ day, start: '08:00', end: '18:00', enabled: day !== 'Sunday' })),
  )

  function toggle(day: string) {
    setSlots((prev) => prev.map((s) => (s.day === day ? { ...s, enabled: !s.enabled } : s)))
  }

  return (
    <div className="page">
      <div className="page-title-row">
        <div>
          <h1>Availability</h1>
          <p className="muted">Set your weekly working hours. Customers can book only within these windows.</p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button">
            Save changes
          </button>
        </div>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Day</th>
              <th>Enabled</th>
              <th>Start</th>
              <th>End</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {slots.map((slot) => (
              <tr key={slot.day}>
                <td className="mono-strong">{slot.day}</td>
                <td>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" checked={slot.enabled} onChange={() => toggle(slot.day)} />
                    {slot.enabled ? 'Open' : 'Closed'}
                  </label>
                </td>
                <td>
                  <input
                    className="field"
                    type="time"
                    value={slot.start}
                    disabled={!slot.enabled}
                    onChange={(e) => setSlots((prev) => prev.map((s) => (s.day === slot.day ? { ...s, start: e.target.value } : s)))}
                  />
                </td>
                <td>
                  <input
                    className="field"
                    type="time"
                    value={slot.end}
                    disabled={!slot.enabled}
                    onChange={(e) => setSlots((prev) => prev.map((s) => (s.day === slot.day ? { ...s, end: e.target.value } : s)))}
                  />
                </td>
                <td>
                  {slot.enabled ? <span className="pill pill-ok">Available</span> : <span className="pill pill-muted">Unavailable</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ marginTop: 12 }}>
        Calendar sync coming soon — for now this mock controls visibility in search.
      </p>
    </div>
  )
}
