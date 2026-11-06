import { useMemo, useState } from 'react';
import { api } from '../../api';
import { ErrorBox, Field, Icon, Seg, Sheet, Spinner, useLoad, useToast } from '../../components/ui';
import { addDays, fmtDay, startOfDayInstant, todayInZone } from '../../lib/time';
import {
  BOOKED_LOOKBACK_DAYS, mostBookedFirst, shareableTimes, shareMessage, spanDays, spanRange, SPAN_DAYS, treatmentLink, type ShareSpan,
} from '../../lib/freeTimes';

const SPANS: { value: ShareSpan; label: string }[] = [{ value: 'week', label: 'This week' }, { value: 'fortnight', label: 'Next 2 weeks' }];

/**
 * Share free times (Today → Your booking link). She picks a treatment, her most-booked first,
 * and this week or the next 2 weeks; the app writes a message listing times a client could book
 * online, with her booking link for that treatment. It works from what the booking page itself
 * sees (public_booking_info and public_busy_times), so it follows the same rules. Share opens the
 * phone's share sheet; Copy puts the message on the clipboard. Nothing is sent by the app.
 */
export function ShareFreeTimesSheet({ bookingUrl, onClose }: { bookingUrl: string; onClose: () => void }) {
  const toast = useToast();
  const { data, error } = useLoad(async () => {
    const info = await api.getBookingInfo();
    const tz = info.timezone;
    const now = new Date();
    const today = todayInZone(tz, now);
    const [busy, appts] = await Promise.all([
      api.getBusyTimes(startOfDayInstant(today, tz), startOfDayInstant(addDays(today, SPAN_DAYS.fortnight), tz)),
      // Her most-booked treatments: the last couple of months and what's booked ahead.
      api.listAppointments(startOfDayInstant(addDays(today, -BOOKED_LOOKBACK_DAYS), tz).toISOString(),
        startOfDayInstant(addDays(today, info.max_days_ahead + 1), tz).toISOString()),
    ]);
    return { info, busy, now, services: mostBookedFirst(info.services, appts) };
  }, []);
  const [picked, setPicked] = useState<string | null>(null);
  const [span, setSpan] = useState<ShareSpan>('week');
  const service = data && (data.services.find((x) => x.id === picked) ?? data.services[0]);
  const out = useMemo(() => {
    if (!data || !service) return null;
    const { info, busy, now } = data;
    const times = shareableTimes(info, service.duration_min, spanDays(info, span, now), busy, now);
    const link = treatmentLink(bookingUrl, service, info.services);
    return { range: spanRange(info, span, now), message: times.length ? shareMessage(service.name, times, info.timezone, link) : null };
  }, [data, service, span, bookingUrl]);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); toast('Message copied'); } catch { window.prompt('Copy your message:', text); }
  }
  async function share(text: string) {
    try {
      await navigator.share({ text });
    } catch (e) {
      // Closing the share sheet is fine; anything else, copy it instead.
      if (!(e instanceof DOMException && e.name === 'AbortError')) await copy(text);
    }
  }

  const tz = data?.info.timezone;
  const day = (d: string) => fmtDay(`${d}T12:00:00Z`, tz);
  return (
    <Sheet title="Share free times" onClose={onClose}>
      <div className="stack od-share">
        <ErrorBox error={error} />
        {!data && !error && <Spinner />}
        {data && !data.info.booking_enabled && (
          <p className="notice warn od-share-none">Online booking is paused, so clients can’t book any times at the moment. You can open it again in Settings → Business details.</p>
        )}
        {data?.info.booking_enabled && !service && (
          <p className="notice warn od-share-none">None of your treatments can be booked online yet. Choose which can in Settings → Treatments.</p>
        )}
        {data?.info.booking_enabled && service && out && (
          <>
            <Field label="Treatment">
              <select value={service.id} onChange={(e) => setPicked(e.target.value)}>
                {data.services.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </Field>
            <div className="field">
              <span aria-hidden="true">When</span>
              <Seg label="When" value={span} onChange={setSpan} options={SPANS} />
              <span className="hint od-share-range">{day(out.range.first)} to {day(out.range.last)}</span>
            </div>
            {out.message ? (
              <>
                <p className="od-share-msg" aria-label="Your message">{out.message}</p>
                <div className="btn-row od-share-btns">
                  {canShare && <button className="btn primary" onClick={() => share(out.message!)}><Icon name="share" size={20} /> Share</button>}
                  <button className={`btn${canShare ? '' : ' primary'}`} onClick={() => copy(out.message!)}><Icon name="copy" size={20} /> Copy{canShare ? '' : ' message'}</button>
                </div>
                <p className="sub od-share-note">Only times clients can book online now. Post it on your Story or Status, or send it to someone who’s asked.</p>
              </>
            ) : (
              <p className="notice od-share-none">
                No free times for {service.name} from {day(out.range.first)} to {day(out.range.last)} that clients could book online.
                {span === 'week' ? ' Try the next 2 weeks.' : ''}
              </p>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
