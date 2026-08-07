package com.scythedevteam.cultwatch;

import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * Downloads the update APK through Android's DownloadManager.
 *
 * The first implementation handed the APK URL to Capacitor's Browser plugin,
 * which opens a Chrome Custom Tab. That looked reasonable and was wrong: a
 * download started inside a Custom Tab belongs to a short-lived session, and when
 * the tab goes away the finalize step is orphaned. The bytes all arrived — the
 * file on disk was byte-for-byte the right size — but it stayed named
 * ".pending-<id>-CultWatch-x.y.z.apk", i.e. still flagged MediaStore IS_PENDING.
 * A pending file is invisible to the installer and reports "Download pending…"
 * forever, so the notification never cleared and every retry queued another one.
 *
 * DownloadManager is the right tool: it owns the transfer at the system level,
 * publishes the file properly on completion, and shows a real progress
 * notification. Setting the APK mime type means tapping that notification hands
 * the file to Android's package installer, so the app never needs
 * REQUEST_INSTALL_PACKAGES — the user stays in control of installing.
 */
@CapacitorPlugin(name = "ApkDownload")
public class ApkDownload extends Plugin {

    private static final String APK_MIME = "application/vnd.android.package-archive";

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String fileName = call.getString("fileName", "CultWatch-update.apk");

        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }

        try {
            // Clear any earlier copy, including one left half-finished by the old
            // Custom Tab path. Without this DownloadManager silently writes
            // "CultWatch-1.4.0-1.apk" and the user accumulates duplicates.
            File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            File existing = new File(dir, fileName);
            if (existing.exists()) {
                //noinspection ResultOfMethodCallIgnored
                existing.delete();
            }

            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setTitle("CultWatch update");
            req.setDescription(fileName);
            req.setMimeType(APK_MIME);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            req.setAllowedOverMetered(true);
            req.setAllowedOverRoaming(false);

            DownloadManager dm = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) {
                call.reject("DownloadManager unavailable");
                return;
            }
            long id = dm.enqueue(req);

            JSObject ret = new JSObject();
            // As a string, deliberately. A DownloadManager id is a long, but it
            // crosses the bridge as JSON where a small value arrives as Integer
            // and PluginCall.getLong() then yields null — which rejected every
            // status() poll with "id is required".
            ret.put("id", String.valueOf(id));
            ret.put("fileName", fileName);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? String.valueOf(e) : e.getMessage());
        }
    }

    /**
     * Progress for an enqueued download. The UI polls this so the pill shows a
     * real percentage that actually reaches 100 — the previous implementation
     * had no progress source at all, so it sat at "Downloading…" indefinitely
     * whether or not anything was happening.
     */
    @PluginMethod
    public void status(PluginCall call) {
        // Accept either form so the bridge's Integer/Long ambiguity cannot break
        // polling again.
        long id;
        try {
            String raw = call.getString("id");
            if (raw == null) {
                Double n = call.getDouble("id");
                if (n == null) { call.reject("id is required"); return; }
                id = n.longValue();
            } else {
                id = Long.parseLong(raw.trim());
            }
        } catch (NumberFormatException e) {
            call.reject("id must be numeric");
            return;
        }
        DownloadManager dm = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) {
            call.reject("DownloadManager unavailable");
            return;
        }

        android.database.Cursor c = null;
        try {
            c = dm.query(new DownloadManager.Query().setFilterById(id));
            JSObject ret = new JSObject();
            if (c == null || !c.moveToFirst()) {
                // The row is gone: the user cleared it, or it was never queued.
                ret.put("state", "gone");
                call.resolve(ret);
                return;
            }

            int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            long soFar = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
            long total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
            int reason = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));

            String state;
            switch (status) {
                case DownloadManager.STATUS_PENDING: state = "pending"; break;
                case DownloadManager.STATUS_RUNNING: state = "running"; break;
                case DownloadManager.STATUS_PAUSED: state = "paused"; break;
                case DownloadManager.STATUS_SUCCESSFUL: state = "success"; break;
                case DownloadManager.STATUS_FAILED: state = "failed"; break;
                default: state = "unknown";
            }

            ret.put("state", state);
            ret.put("bytes", soFar);
            ret.put("total", total);
            ret.put("percent", total > 0 ? (int) (soFar * 100 / total) : 0);
            ret.put("reason", reason);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? String.valueOf(e) : e.getMessage());
        } finally {
            if (c != null) c.close();
        }
    }

    /** Opens the system Downloads UI so the user can tap the finished APK. */
    @PluginMethod
    public void openDownloads(PluginCall call) {
        try {
            android.content.Intent i = new android.content.Intent(DownloadManager.ACTION_VIEW_DOWNLOADS);
            i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? String.valueOf(e) : e.getMessage());
        }
    }
}
