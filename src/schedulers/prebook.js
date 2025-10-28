// src/schedulers/prebook.js
export function startPrebookScheduler({
  Ride,
  dispatchToNearestDriver,
  logActivity,
  leewayMin = Number(process.env.PREBOOK_DISPATCH_LEEWAY_MIN || 15),
  intervalMs = 30_000
}) {
  async function runPrebookSweep() {
    try {
      const now = Date.now();
      const horizon = new Date(now + leewayMin * 60 * 1000);

      const due = await Ride.find({
        status: 'scheduled',
        scheduledDispatched: { $ne: true },
        scheduledFor: { $lte: horizon }
      }).sort({ scheduledFor: 1 }).limit(50).lean();

      for (const r of due) {
        try {
          const upd = await Ride.updateOne(
            { _id: r._id, status: 'scheduled', scheduledDispatched: { $ne: true } },
            { $set: { status: 'pending', scheduledDispatched: true } }
          );

          if (upd.modifiedCount > 0) {
            try {
              await logActivity({
                rideId: r._id,
                type: 'scheduled_pending',
                actorType: 'system',
                message: `Scheduled ride activated (was for ${r.scheduledFor?.toISOString?.() || 'N/A'})`
              });
            } catch {}
            await dispatchToNearestDriver({ rideId: String(r._id) });
          }
        } catch (e) {
          console.warn('prebook activate failed:', e?.message || e);
        }
      }
    } catch (e) {
      console.warn('runPrebookSweep error:', e?.message || e);
    }
  }

  const id = setInterval(runPrebookSweep, intervalMs);
  console.log(`⏱️ Prebook scheduler running (every ${intervalMs} ms, leeway ${leewayMin} min)`);
  return () => clearInterval(id);
}
