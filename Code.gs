// =====================================================================
//  SETTINGS  (safe to edit)
// =====================================================================

// Background mode stops for the day after this many minutes of actual
// trigger runtime. Google's cap for @gmail.com accounts is about 90 min/day,
// so 75 leaves a safety margin. (Workspace accounts get about 6 hours.)
var DAILY_RUNTIME_LIMIT_MIN = 75;

// After the limit is reached, wait this many hours before resuming.
var PAUSE_HOURS = 24;

// Timezone used when showing times in emails and on the page.
var DISPLAY_TZ = 'Asia/Dhaka';   // GMT+6

// =====================================================================
//  MENU
// =====================================================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Drive Tools')
    .addItem('Move Files', 'showMoveModal')
    .addItem('Smart Migrate to Shared Drive', 'showMigrateModal')
    .addToUi();
}

function showMoveModal() {
  var html = HtmlService.createHtmlOutputFromFile('SheetMoveModal')
      .setWidth(500)
      .setHeight(340);
  SpreadsheetApp.getUi().showModalDialog(html, 'Move Drive Items');
}

function showMigrateModal() {
  var html = HtmlService.createHtmlOutputFromFile('MigrateModal')
      .setWidth(640)
      .setHeight(760);
  SpreadsheetApp.getUi().showModalDialog(html, 'Smart Migrate to Shared Drive');
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('Drive Bulk File Mover');
}

// =====================================================================
//  SIMPLE MOVER (unchanged behaviour)
// =====================================================================

function processMoveRequests(itemsRaw, targetFolderUrl) {
  var targetFolderId = extractIdFromUrl(targetFolderUrl);
  if (!targetFolderId) {
    return { error: "Invalid target folder URL provided." };
  }

  var targetFolder;
  try {
    targetFolder = DriveApp.getFolderById(targetFolderId);
  } catch (e) {
    return { error: "Could not access target folder. Please check permissions." };
  }

  var lines = itemsRaw.split("\n");
  var successCount = 0;
  var failCount = 0;

  for (var i = 0; i < lines.length; i++) {
    var rawUrl = lines[i].trim();
    if (!rawUrl) continue;

    var itemId = extractIdFromUrl(rawUrl);
    if (!itemId) {
      failCount++;
      continue;
    }

    if (rawUrl.includes("/folders/")) {
      try {
        var sourceFolder = DriveApp.getFolderById(itemId);

        var files = sourceFolder.getFiles();
        while (files.hasNext()) {
          try {
            files.next().moveTo(targetFolder);
            successCount++;
          } catch (err) { failCount++; }
        }

        var subFolders = sourceFolder.getFolders();
        while (subFolders.hasNext()) {
          try {
            subFolders.next().moveTo(targetFolder);
            successCount++;
          } catch (err) { failCount++; }
        }
      } catch (err) {
        failCount++;
      }
    } else {
      try {
        var file = DriveApp.getFileById(itemId);
        file.moveTo(targetFolder);
        successCount++;
      } catch (err) {
        failCount++;
      }
    }
  }

  return {
    successCount: successCount,
    failCount: failCount,
    folderUrl: targetFolderUrl
  };
}

function processSheetMoveRequests(targetFolderUrl) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var lastRow = sheet.getLastRow();

  if (lastRow < 1) {
    return { error: "No URLs found in Column B." };
  }

  var fileValues = sheet.getRange(1, 2, lastRow, 1).getValues();
  var urlList = [];

  for (var i = 0; i < fileValues.length; i++) {
    var val = fileValues[i][0] ? fileValues[i][0].toString().trim() : "";
    if (val && (val.indexOf("http://") === 0 || val.indexOf("https://") === 0)) {
      urlList.push(val);
    }
  }

  if (urlList.length === 0) {
    return { error: "No valid Drive URLs found in Column B starting from row 1." };
  }

  return processMoveRequests(urlList.join("\n"), targetFolderUrl);
}

function extractIdFromUrl(url) {
  var match = url.match(/[-\w]{25,}/);
  return match ? match[0] : null;
}

// =====================================================================
//  SMART MIGRATION ENGINE (Personal Drive -> Shared Drive)
//
//  Strategy per subfolder:
//    1. Try moveTo() on the whole folder (fast path).
//    2. If it fails: walk the folder tree. For every file NOT owned by
//       the user:
//          a) (optional) make a copy right next to it, inside the SOURCE
//             folder (the copy is owned by the user, so it can move)
//          b) move the foreign original into the ONE root [Unmovable]
//       then retry moving the whole folder. The copies travel with it.
//    3. If it still fails (hidden files): recreate the folder in the
//       shared drive and process its visible contents the same way.
//       Once a recreated folder's contents have all been moved out or
//       copied, the now-empty original is removed from the source.
//
//  Run modes:
//    - Foreground: the open page calls continueMigration() in ~25s slices
//      (a single long Drive operation inside a slice can run past this;
//      Apps Script still hard-stops any single execution at 6 minutes).
//    - Background: a 1-minute time-driven trigger calls backgroundTick(),
//      which works in ~4.5 minute slices. No browser needed.
//      Total background runtime is capped per day (see SETTINGS). When the
//      cap is reached the migration pauses and a one-time trigger resumes
//      it PAUSE_HOURS later. NOTE: manually clicking "Continue Migration"
//      while paused runs through the browser rather than the trigger, so it
//      is not blocked by the pause -- but it still shares Google's overall
//      per-day script/Drive quotas, so it can also get stuck or fail if
//      those are exhausted, same as any other run.
//    A user lock guarantees only one worker runs at a time.
// =====================================================================

var SLICE_MS = 25 * 1000;              // foreground: each call works ~25s, then returns to the UI
var BG_SLICE_MS = 4.5 * 60 * 1000;     // background: nobody is waiting, so use most of the 6-minute limit
var STATE_KEY = 'MIGRATION_STATE';
var MAX_LOG = 400;
var TRIGGER_HANDLER = 'backgroundTick';
var RESUME_HANDLER = 'resumeTick';
var MAX_BG_FAILURES = 5;               // stop background mode after this many failed runs in a row
var LOCK_WAIT_MS = 5000;

/**
 * Starts a fresh migration and runs the first slice.
 * options: {
 *   copyForeignFiles: boolean,
 *   background: boolean,
 *   ccEmails: string[],                 // additional recipients, besides the account owner
 *   notify: { pause: bool, resume: bool, complete: bool }
 * }
 */
function startMigration(sourceUrl, targetUrl, options) {
  options = options || {};

  if (!sourceUrl || !targetUrl) return { error: 'Both folder URLs are required.' };
  if (sourceUrl.indexOf('/folders/') === -1) return { error: 'Source must be a folder URL.' };
  if (targetUrl.indexOf('/folders/') === -1) return { error: 'Target must be a folder URL.' };

  var sourceId = extractIdFromUrl(sourceUrl);
  var targetId = extractIdFromUrl(targetUrl);
  if (!sourceId) return { error: 'Invalid source folder URL.' };
  if (!targetId) return { error: 'Invalid target folder URL.' };
  if (sourceId === targetId) return { error: 'Source and target cannot be the same folder.' };

  // Hold the lock while checking + creating state, so two people clicking Start
  // at the same moment cannot both begin a migration.
  var lock = LockService.getUserLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    return { error: 'A migration is already running. A new one cannot be started until it is finished.',
             alreadyRunning: true, status: getMigrationStatus() };
  }

  try {
    var existingRaw = PropertiesService.getUserProperties().getProperty(STATE_KEY);
    if (existingRaw) {
      var existing = JSON.parse(existingRaw);
      if (!existing.finished) {
        return { error: 'A migration of "' + existing.sourceName + '" is already running. ' +
                        'A new one cannot be started until it is finished.',
                 alreadyRunning: true, status: buildReport(existing) };
      }
    }

    var source, target;
    try { source = DriveApp.getFolderById(sourceId); }
    catch (e) { return { error: 'Cannot access source folder: ' + e.message }; }
    try { target = DriveApp.getFolderById(targetId); }
    catch (e) { return { error: 'Cannot access target folder: ' + e.message }; }

    var sourceName = source.getName();
    var sdFolder = target.createFolder('[SD] ' + sourceName);
    var unmovable = source.createFolder('[Unmovable] ' + sourceName);

    var state = {
      sourceId: sourceId,
      sourceName: sourceName,
      sdRootId: sdFolder.getId(),
      unmovableId: unmovable.getId(),
      copyForeign: !!options.copyForeignFiles,
      background: !!options.background,
      notifyEmail: Session.getEffectiveUser().getEmail() || '',
      ccEmails: sanitizeEmailList(options.ccEmails),
      notify: sanitizeNotifyPrefs(options.notify),
      myEmail: Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail(),
      startedAt: Date.now(),
      bgFailures: 0,
      lastRunAt: null,
      lastError: '',
      runtimeMs: 0,              // background runtime used in the current window
      pausedUntil: null,         // ms timestamp when a daily-limit pause ends
      // Queue of folders whose contents still need handling
      queue: [{
        srcId: sourceId,
        dstId: sdFolder.getId(),
        path: sourceName,
        filesDone: false
      }],
      foldersTotal: 1,          // discovered so far (grows as subfolders are found)
      foldersDone: 0,           // fully processed
      stats: { files: 0, foldersMoved: 0, foldersRecreated: 0, foldersEmptied: 0, hiddenFolders: 0, parked: 0, copied: 0, errors: 0 },
      log: [],
      finished: false,
      shortcutDone: false
    };

    addLog(state, 'Created "[SD] ' + sourceName + '" in target and "[Unmovable] ' + sourceName + '" in source.');

    if (state.background) {
      var trig = installTrigger();
      if (trig.ok) {
        addLog(state, 'Background mode ON: a trigger will keep the migration running even if this page is closed.');
      } else {
        state.background = false;
        addLog(state, 'Could not enable background mode (' + trig.error + '). Running in foreground only.');
      }
    }

    saveState(state);
  } finally {
    lock.releaseLock();
  }

  return continueMigration();
}

/**
 * Updates CC recipients and/or which email types are sent, for a migration
 * that is already running or paused. Safe to call at any time: it only
 * touches saved state (protected by the same lock as everything else) and
 * does not interrupt a slice in progress, background or foreground.
 * options: { ccEmails: string[]|undefined, notify: {pause,resume,complete}|undefined }
 */
function updateEmailSettings(options) {
  options = options || {};
  var lock = LockService.getUserLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    var raw = PropertiesService.getUserProperties().getProperty(STATE_KEY);
    if (!raw) return { error: 'No migration in progress.' };
    var state = JSON.parse(raw);

    if (options.ccEmails !== undefined) {
      state.ccEmails = sanitizeEmailList(options.ccEmails);
    }
    if (options.notify !== undefined) {
      state.notify = sanitizeNotifyPrefs(options.notify, state.notify);
    }
    addLog(state, 'Email settings updated (CC: ' + (state.ccEmails.length ? state.ccEmails.join(', ') : 'none') +
      '; notify: pause=' + state.notify.pause + ', resume=' + state.notify.resume + ', complete=' + state.notify.complete + ').');
    saveState(state);
    return buildReport(state);
  } finally {
    lock.releaseLock();
  }
}

function sanitizeEmailList(list) {
  if (!list || !list.length) return [];
  var seen = {};
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var e = (list[i] || '').toString().trim();
    if (!e) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) continue;   // basic email shape check
    var key = e.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    out.push(e);
  }
  return out;
}

function sanitizeNotifyPrefs(notify, fallback) {
  var base = fallback || { pause: true, resume: true, complete: true };
  if (!notify) return base;
  return {
    pause: notify.pause !== undefined ? !!notify.pause : base.pause,
    resume: notify.resume !== undefined ? !!notify.resume : base.resume,
    complete: notify.complete !== undefined ? !!notify.complete : base.complete
  };
}

/**
 * Foreground entry point. The browser calls this repeatedly until
 * finished === true, updating the progress bar between calls.
 *
 * If a background trigger is currently working, this does not start a
 * second worker; it just returns the latest saved progress.
 *
 * If the migration is paused for the daily limit, a person being present is
 * treated as an intentional manual continue (it does not use trigger quota,
 * though it still shares Google's other per-day quotas -- see the note in
 * the strategy comment above).
 */
function continueMigration() {
  var lock = LockService.getUserLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    var busy = getMigrationStatus();
    if (busy.none) return { error: 'No migration in progress. Start a new one.' };
    busy.workerBusy = true;
    return busy;
  }

  try {
    return runSlice(SLICE_MS);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Background entry point, called by the every-minute trigger.
 * Runs with no browser attached.
 */
function backgroundTick() {
  var lock = LockService.getUserLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return;   // another worker is active; try again next minute

  try {
    var raw = PropertiesService.getUserProperties().getProperty(STATE_KEY);
    if (!raw) { removeTriggers(); return; }

    var state = JSON.parse(raw);

    if (state.finished || !state.background) {
      removeTriggers();
      return;
    }

    // Already paused for the daily limit? The resume trigger will handle it.
    if (state.pausedUntil && Date.now() < state.pausedUntil) {
      removeTriggers(TRIGGER_HANDLER);
      return;
    }

    var limitMs = DAILY_RUNTIME_LIMIT_MIN * 60 * 1000;
    var remainingMs = limitMs - (state.runtimeMs || 0);

    if (remainingMs <= 0) {
      pauseForDailyLimit(state);
      return;
    }

    // Last run shrinks to fit the remaining budget (never below 20 seconds)
    var sliceMs = Math.max(20 * 1000, Math.min(BG_SLICE_MS, remainingMs));
    var startedAt = Date.now();

    try {
      runSlice(sliceMs);

      var fresh = JSON.parse(PropertiesService.getUserProperties().getProperty(STATE_KEY));
      fresh.runtimeMs = (fresh.runtimeMs || 0) + (Date.now() - startedAt);
      fresh.bgFailures = 0;
      fresh.lastError = '';

      if (!fresh.finished && fresh.runtimeMs >= limitMs) {
        pauseForDailyLimit(fresh);   // saves state itself
      } else {
        saveState(fresh);
      }
    } catch (e) {
      var st = JSON.parse(PropertiesService.getUserProperties().getProperty(STATE_KEY) || raw);
      st.runtimeMs = (st.runtimeMs || 0) + (Date.now() - startedAt);
      st.bgFailures = (st.bgFailures || 0) + 1;
      st.lastError = e.message;
      addLog(st, 'Background run failed (' + st.bgFailures + '/' + MAX_BG_FAILURES + '): ' + e.message);

      if (st.bgFailures >= MAX_BG_FAILURES) {
        st.background = false;
        removeTriggers();
        addLog(st, 'Background mode stopped after repeated failures. Open the tool and click Continue to resume.');
        saveState(st);
        sendEmail(st, 'complete_or_error', 'Drive migration stopped',
          'The background migration of "' + st.sourceName + '" stopped after ' + MAX_BG_FAILURES +
          ' failed runs in a row.\n\nLast error: ' + e.message +
          '\n\nOpen the tool and click "Continue Migration" to resume.');
      } else {
        saveState(st);
      }
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Fired once, PAUSE_HOURS after a daily-limit pause. Starts a fresh
 * runtime window and re-creates the every-minute trigger.
 */
function resumeTick() {
  var lock = LockService.getUserLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return;

  try {
    removeTriggers(RESUME_HANDLER);   // this one-time trigger has done its job

    var raw = PropertiesService.getUserProperties().getProperty(STATE_KEY);
    if (!raw) { removeTriggers(); return; }

    var state = JSON.parse(raw);
    if (state.finished || !state.background) { removeTriggers(); return; }

    state.runtimeMs = 0;
    state.pausedUntil = null;
    state.bgFailures = 0;

    var t = installTrigger();
    if (t.ok) {
      addLog(state, 'Resumed automatically after the daily-limit pause.');
      saveState(state);
      sendEmail(state, 'resume', 'Drive migration resumed: ' + state.sourceName,
        'The migration of "' + state.sourceName + '" has resumed automatically.\n\n' +
        'Progress so far: ' + state.foldersDone + ' of ' + state.foldersTotal + ' folders.');
    } else {
      state.background = false;
      addLog(state, 'Could not resume in the background (' + t.error + '). Open the tool and click Continue.');
      saveState(state);
      sendEmail(state, 'complete_or_error', 'Drive migration could not resume',
        'The migration of "' + state.sourceName + '" could not resume automatically: ' + t.error +
        '\n\nOpen the tool and click "Continue Migration".');
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Stops background work for now, schedules a one-time resume trigger
 * PAUSE_HOURS from now, saves state and emails the user.
 * Callers must hold the lock.
 */
function pauseForDailyLimit(state) {
  removeTriggers(TRIGGER_HANDLER);
  removeTriggers(RESUME_HANDLER);

  var resumeAt = Date.now() + PAUSE_HOURS * 60 * 60 * 1000;
  state.pausedUntil = resumeAt;

  var scheduled = false;
  try {
    ScriptApp.newTrigger(RESUME_HANDLER).timeBased().at(new Date(resumeAt)).create();
    scheduled = true;
  } catch (e) {
    addLog(state, 'Could not schedule the automatic resume: ' + e.message);
  }

  var when = formatDhaka(resumeAt);
  addLog(state, 'Daily runtime limit of ' + DAILY_RUNTIME_LIMIT_MIN + ' min reached. ' +
    (scheduled ? 'Paused; will resume automatically on ' + when + '.' : 'Paused; click Continue to resume.'));

  if (!scheduled) state.background = false;
  saveState(state);

  sendEmail(state, 'pause', 'Drive migration paused: ' + state.sourceName,
    'The migration of "' + state.sourceName + '" reached the daily runtime limit (' +
    DAILY_RUNTIME_LIMIT_MIN + ' minutes) and has paused.\n\n' +
    (scheduled
      ? 'It will continue automatically on ' + when + '.\n\n'
      : 'Automatic resume could not be scheduled. Open the tool and click "Continue Migration".\n\n') +
    'Note: you can also click "Continue Migration" yourself at any time while paused -- this runs ' +
    'through your browser rather than waiting for the scheduled resume. It is not blocked by this ' +
    'daily pause, but it still shares Google\'s other per-day script and Drive quotas, so it can ' +
    'occasionally get stuck or fail if those happen to be exhausted too.\n\n' +
    'Progress so far: ' + state.foldersDone + ' of ' + state.foldersTotal + ' folders discovered so far.\n' +
    'Files moved individually: ' + state.stats.files + '\n' +
    'Folders moved whole: ' + state.stats.foldersMoved + '\n' +
    'Errors: ' + state.stats.errors);
}

/**
 * Does one time-boxed slice of work and saves state.
 * Callers must hold the lock.
 */
function runSlice(sliceMs) {
  var raw = PropertiesService.getUserProperties().getProperty(STATE_KEY);
  if (!raw) return { error: 'No migration in progress. Start a new one.' };

  var state = JSON.parse(raw);
  if (state.finished) return buildReport(state);

  var deadline = Date.now() + sliceMs;

  while (state.queue.length > 0 && Date.now() < deadline) {
    var job = state.queue.shift();
    try {
      processFolderJob(state, job, deadline);
    } catch (e) {
      state.stats.errors++;
      addLog(state, 'ERROR in "' + job.path + '": ' + e.message);
      state.foldersDone++;
    }
  }

  state.lastRunAt = Date.now();

  if (state.queue.length === 0) {
    finalize(state);
  }

  saveState(state);
  return buildReport(state);
}

/**
 * Handles one folder: moves its files, then deals with each subfolder.
 * If the deadline hits midway, the job is re-queued (safe to resume, since
 * already-moved items are no longer in the source).
 */
function processFolderJob(state, job, deadline) {
  var src = DriveApp.getFolderById(job.srcId);
  var dst = DriveApp.getFolderById(job.dstId);

  // ---- 1. Files directly inside this folder ----
  if (!job.filesDone) {
    var files = src.getFiles();
    while (files.hasNext()) {
      if (Date.now() > deadline) { state.queue.unshift(job); return; }
      moveFile(state, files.next(), dst, job.path);
    }
    job.filesDone = true;
  }

  // ---- 2. Subfolders ----
  var subs = src.getFolders();
  var subList = [];
  while (subs.hasNext()) subList.push(subs.next());

  for (var i = 0; i < subList.length; i++) {
    if (Date.now() > deadline) { state.queue.unshift(job); return; }

    var sub = subList[i];
    var subId = sub.getId();
    if (subId === state.unmovableId) continue;   // never touch our helper folder

    var subName = sub.getName();
    var subPath = job.path + '/' + subName;

    // ---- Attempt A: move the whole folder ----
    if (tryMoveFolder(sub, dst)) {
      state.stats.foldersMoved++;
      addLog(state, 'Moved folder (whole): ' + subPath);
      continue;
    }

    // ---- Attempt B: clear blockers (copy in place + park original), then retry ----
    addLog(state, 'Blocked: ' + subPath + ' - clearing problem files...');
    var cleared = clearBlockers(state, sub, subPath, deadline);

    if (cleared === 'timeout') { state.queue.unshift(job); return; }

    if (tryMoveFolder(sub, dst)) {
      state.stats.foldersMoved++;
      addLog(state, 'Moved folder (after clearing): ' + subPath);
      continue;
    }

    // ---- Attempt C: still blocked after clearing every visible problem file.
    //      This can happen because of a file the script cannot enumerate
    //      (commonly referred to here as a "hidden file"), or some other
    //      folder-level restriction the script can't diagnose further.
    //      Recreate the folder in the Shared Drive and go one level deeper
    //      to move out everything that IS visible. The original is tracked
    //      so it can be handled once its visible contents are dealt with:
    //      trashed if it truly ends up empty, or moved whole into
    //      [Unmovable] > Hidden Files in Folders if something remains that
    //      the script still could not move or see clearly. ----
    var newDst = dst.createFolder(subName);
    state.stats.foldersRecreated++;
    state.foldersTotal++;
    addLog(state, 'Recreated folder in Shared Drive (possible hidden items): ' + subPath);
    state.queue.push({
      srcId: subId,
      dstId: newDst.getId(),
      path: subPath,
      filesDone: false,
      cleanupRecreatedSrc: true   // after this job's contents are handled, resolve the leftover original
    });
  }

  // If this job's own folder was marked for cleanup (i.e. it was a
  // recreated folder), resolve the leftover original now that everything
  // visible inside it has been moved out or copied elsewhere: trash it if
  // it ended up empty, otherwise move it whole into [Unmovable] > Hidden
  // Files in Folders so nothing is silently lost or left cluttering the
  // source.
  if (job.cleanupRecreatedSrc) {
    resolveRecreatedSourceFolder(state, src, job.path);
  }

  state.foldersDone++;
}

/**
 * Resolves the leftover original folder after a "recreate" pass:
 *   - if it is now empty (no files, no subfolders), trash it.
 *   - otherwise, something inside it could not be moved or seen clearly
 *     (most likely a hidden file). Move the whole folder, as-is, into
 *     [Unmovable] > Hidden Files in Folders (a flat drop -- just the
 *     folder's own name, no path recreated) so it stays intact and visible
 *     for manual review rather than being trashed with unverified contents.
 */
function resolveRecreatedSourceFolder(state, folder, path) {
  try {
    if (!folder.getFiles().hasNext() && !folder.getFolders().hasNext()) {
      folder.setTrashed(true);
      state.stats.foldersEmptied++;
      addLog(state, 'Removed empty source folder: ' + path);
      return;
    }
  } catch (e) {
    addLog(state, 'Could not check/remove empty source folder ' + path + ': ' + e.message);
    return;
  }

  try {
    var holder = getOrCreateHiddenFilesHolder(state);
    folder.moveTo(holder);
    state.stats.hiddenFolders++;
    addLog(state, 'Folder still had unresolved contents, moved to [Unmovable] > Hidden Files in Folders: ' + path);
  } catch (e2) {
    state.stats.errors++;
    addLog(state, 'LEFT IN PLACE (could not move to Hidden Files in Folders): ' + path + ' (' + e2.message + ')');
  }
}

/**
 * Returns the "Hidden Files in Folders" subfolder inside [Unmovable],
 * creating it on first use. Cached on state so repeated calls within the
 * same run don't re-look-it-up every time, and a fresh lookup by name
 * after a resume (state.hiddenFilesFolderId not yet set) reuses an
 * existing one instead of creating a duplicate.
 */
function getOrCreateHiddenFilesHolder(state) {
  if (state.hiddenFilesFolderId) {
    try { return DriveApp.getFolderById(state.hiddenFilesFolderId); } catch (e) { /* fall through and recreate */ }
  }
  var unmov = DriveApp.getFolderById(state.unmovableId);
  var existing = unmov.getFoldersByName('Hidden Files in Folders');
  var holder = existing.hasNext() ? existing.next() : unmov.createFolder('Hidden Files in Folders');
  state.hiddenFilesFolderId = holder.getId();
  return holder;
}

/**
 * Moves a single file into the mirrored destination folder.
 * If it cannot be moved (foreign-owned), it is copied into the destination
 * (which IS the mirrored path) and the original is parked in [Unmovable].
 */
function moveFile(state, file, dst, path) {
  var name = file.getName();
  try {
    file.moveTo(dst);
    state.stats.files++;
    return;
  } catch (e) {
    // Most likely owned by someone else
  }

  var owner = safeOwnerEmail(file);

  if (state.copyForeign) {
    try {
      file.makeCopy(name, dst);
      state.stats.copied++;
      addLog(state, 'Copied foreign file to Shared Drive: ' + path + '/' + name + (owner ? ' [' + owner + ']' : ''));
    } catch (e2) {
      addLog(state, 'Copy failed: ' + path + '/' + name + ' (' + e2.message + ')');
    }
  }

  try {
    file.moveTo(DriveApp.getFolderById(state.unmovableId));
    state.stats.parked++;
    addLog(state, 'Parked in [Unmovable]: ' + path + '/' + name);
  } catch (e3) {
    state.stats.errors++;
    addLog(state, 'LEFT IN PLACE (no permission): ' + path + '/' + name);
  }
}

/**
 * Attempts to move a folder. Returns true on success.
 */
function tryMoveFolder(folder, dstFolder) {
  try {
    folder.moveTo(dstFolder);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Walks a folder tree (inside the SOURCE). Every file the user does not own:
 *   a) optionally gets a copy made right next to it, in the same source folder
 *      (the copy is owned by the user, so it travels with the folder later)
 *   b) is moved into the single root [Unmovable] folder
 *
 * Returns 'ok' or 'timeout'.
 */
function clearBlockers(state, folder, path, deadline) {
  var stack = [{ folder: folder, path: path }];
  var unmov = DriveApp.getFolderById(state.unmovableId);

  while (stack.length > 0) {
    if (Date.now() > deadline) return 'timeout';

    var node = stack.pop();
    var files = node.folder.getFiles();

    // Collect first: we modify the folder while iterating otherwise
    var foreign = [];
    while (files.hasNext()) {
      var f = files.next();
      if (!isOwnedByMe(state, f)) foreign.push(f);
    }

    for (var i = 0; i < foreign.length; i++) {
      if (Date.now() > deadline) return 'timeout';

      var file = foreign[i];
      var fname = file.getName();
      var owner = safeOwnerEmail(file);

      var copyOk = true;
      if (state.copyForeign) {
        try {
          file.makeCopy(fname, node.folder);      // copy lands next to the original
          state.stats.copied++;
          addLog(state, 'Copied in place: ' + node.path + '/' + fname + (owner ? ' [' + owner + ']' : ''));
        } catch (e) {
          copyOk = false;
          addLog(state, 'Copy failed: ' + node.path + '/' + fname + ' (' + e.message + ')');
        }
      }

      try {
        file.moveTo(unmov);
        state.stats.parked++;
        addLog(state, 'Parked in [Unmovable]: ' + node.path + '/' + fname + (copyOk ? '' : ' (no copy made)'));
      } catch (e2) {
        state.stats.errors++;
        addLog(state, 'LEFT IN PLACE (no permission): ' + node.path + '/' + fname);
      }
    }

    var subs = node.folder.getFolders();
    while (subs.hasNext()) {
      var s = subs.next();
      if (s.getId() === state.unmovableId) continue;
      stack.push({ folder: s, path: node.path + '/' + s.getName() });
    }
  }
  return 'ok';
}

function isOwnedByMe(state, file) {
  try {
    var owner = file.getOwner();
    if (!owner) return true;   // no owner info - treat as movable
    return owner.getEmail() === state.myEmail;
  } catch (e) {
    return false;
  }
}

function safeOwnerEmail(file) {
  try { return file.getOwner() ? file.getOwner().getEmail() : ''; } catch (e) { return ''; }
}

/**
 * Wraps up: shortcut, cleanup, trigger removal, finish email.
 */
function finalize(state) {
  if (!state.shortcutDone) {
    try {
      Drive.Files.create({
        name: '[SD] ' + state.sourceName,
        mimeType: 'application/vnd.google-apps.shortcut',
        parents: [state.sourceId],
        shortcutDetails: { targetId: state.sdRootId }
      }, null, { supportsAllDrives: true });
      state.shortcutDone = true;
      addLog(state, 'Shortcut "[SD] ' + state.sourceName + '" created inside the original folder.');
    } catch (e) {
      addLog(state, 'Shortcut creation failed: ' + e.message + ' (is the Drive API advanced service enabled?)');
    }
  }

  // Remove [Unmovable] if it stayed empty
  try {
    var u = DriveApp.getFolderById(state.unmovableId);
    if (!u.getFiles().hasNext() && !u.getFolders().hasNext()) {
      u.setTrashed(true);
      state.unmovableRemoved = true;
      addLog(state, '[Unmovable] folder was empty, so it was removed.');
    }
  } catch (e) {}

  state.foldersDone = state.foldersTotal;
  state.finished = true;
  state.pausedUntil = null;
  addLog(state, 'Migration finished.');

  removeTriggers();

  if (state.background) {
    var s = state.stats;
    sendEmail(state, 'complete', 'Drive migration finished: ' + state.sourceName,
      'The migration of "' + state.sourceName + '" has finished.\n\n' +
      'Files moved individually: ' + s.files + '\n' +
      'Folders moved whole: ' + s.foldersMoved + '\n' +
      'Folders recreated: ' + s.foldersRecreated + '\n' +
      'Empty source folders removed: ' + s.foldersEmptied + '\n' +
      'Folders moved to [Unmovable] > Hidden Files in Folders: ' + s.hiddenFolders + '\n' +
      'Parked in [Unmovable]: ' + s.parked + '\n' +
      'Copied: ' + s.copied + '\n' +
      'Errors: ' + s.errors + '\n\n' +
      'Personal folder: https://drive.google.com/drive/folders/' + state.sourceId + '\n' +
      'Shared Drive Folder: https://drive.google.com/drive/folders/' + state.sdRootId + '\n' +
      (state.unmovableRemoved ? '' : 'Unmovable folder: https://drive.google.com/drive/folders/' + state.unmovableId + '\n'));
  }
}

// =====================================================================
//  BACKGROUND MODE: TRIGGERS + EMAIL
// =====================================================================

/** Creates the every-minute trigger if it does not already exist. */
function installTrigger() {
  try {
    var existing = ScriptApp.getProjectTriggers();
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].getHandlerFunction() === TRIGGER_HANDLER) return { ok: true };
    }
    ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyMinutes(1).create();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Deletes this project's background triggers.
 * Pass a handler name to remove only that kind; omit it to remove all of them
 * (the every-minute trigger AND the one-time resume trigger).
 */
function removeTriggers(onlyHandler) {
  try {
    var all = ScriptApp.getProjectTriggers();
    for (var i = 0; i < all.length; i++) {
      var h = all[i].getHandlerFunction();
      var mine = (h === TRIGGER_HANDLER || h === RESUME_HANDLER);
      if (!mine) continue;
      if (onlyHandler && h !== onlyHandler) continue;
      ScriptApp.deleteTrigger(all[i]);
    }
  } catch (e) {}
}

function hasTrigger() {
  try {
    var all = ScriptApp.getProjectTriggers();
    for (var i = 0; i < all.length; i++) {
      var h = all[i].getHandlerFunction();
      if (h === TRIGGER_HANDLER || h === RESUME_HANDLER) return true;
    }
  } catch (e) {}
  return false;
}

/**
 * Sends an email for a given event kind, honoring the migration's notify
 * preferences and including any CC recipients. kind is one of:
 * 'pause', 'resume', 'complete', or 'complete_or_error' (always sent,
 * used for failure/stop notices that don't have their own toggle).
 */
function sendEmail(state, kind, subject, body) {
  try {
    if (!state.notifyEmail) return;

    var notify = state.notify || { pause: true, resume: true, complete: true };
    if (kind === 'pause' && !notify.pause) return;
    if (kind === 'resume' && !notify.resume) return;
    if (kind === 'complete' && !notify.complete) return;
    // 'complete_or_error' always sends, regardless of the toggles

    var options = {};
    var cc = (state.ccEmails || []).join(',');
    if (cc) options.cc = cc;

    MailApp.sendEmail(state.notifyEmail, subject, body, options);
  } catch (e) {
    addLog(state, 'Could not send email: ' + e.message);
  }
}

/** Formats a timestamp in the display timezone (Dhaka, GMT+6). */
function formatDhaka(ms) {
  return Utilities.formatDate(new Date(ms), DISPLAY_TZ, "EEE d MMM yyyy, h:mm a") + ' (Dhaka, GMT+6)';
}

/** UI button: switch background mode on/off for a running migration. */
function setBackgroundMode(enabled) {
  var lock = LockService.getUserLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    var raw = PropertiesService.getUserProperties().getProperty(STATE_KEY);
    if (!raw) return { error: 'No migration in progress.' };
    var state = JSON.parse(raw);
    if (state.finished) return buildReport(state);

    if (enabled) {
      var t = installTrigger();
      if (!t.ok) return { error: 'Could not enable background mode: ' + t.error };
      // Turning it on manually starts a fresh window and cancels any pending pause
      removeTriggers(RESUME_HANDLER);
      state.background = true;
      state.bgFailures = 0;
      state.pausedUntil = null;
      state.runtimeMs = 0;
      addLog(state, 'Background mode turned ON.');
    } else {
      removeTriggers();
      state.background = false;
      state.pausedUntil = null;
      addLog(state, 'Background mode turned OFF. Use the page (Continue Migration) to keep going.');
    }
    saveState(state);
    return buildReport(state);
  } finally {
    lock.releaseLock();
  }
}

// =====================================================================
//  STATE / REPORTING HELPERS
// =====================================================================

function addLog(state, msg) {
  var t = Utilities.formatDate(new Date(), DISPLAY_TZ, 'HH:mm:ss');
  state.log.push('[' + t + '] ' + msg);
  if (state.log.length > MAX_LOG) state.log = state.log.slice(-MAX_LOG);
}

function saveState(state) {
  PropertiesService.getUserProperties().setProperty(STATE_KEY, JSON.stringify(state));
}

function buildReport(state) {
  var percent = state.finished ? 100 :
    Math.min(99, Math.round((state.foldersDone / Math.max(1, state.foldersTotal)) * 100));

  var paused = !!(state.pausedUntil && Date.now() < state.pausedUntil && !state.finished);

  return {
    finished: state.finished,
    percent: percent,
    foldersDone: state.foldersDone,
    foldersTotal: state.foldersTotal,
    remaining: state.queue.length,
    stats: state.stats,
    log: state.log.slice(-60),
    sourceName: state.sourceName,
    background: !!state.background,
    triggerActive: hasTrigger(),
    lastRunAt: state.lastRunAt || null,
    lastError: state.lastError || '',
    startedAt: state.startedAt || null,
    startedAtText: state.startedAt ? formatDhaka(state.startedAt) : '',
    paused: paused,
    resumeAt: paused ? state.pausedUntil : null,
    resumeAtText: paused ? formatDhaka(state.pausedUntil) : '',
    runtimeMinUsed: Math.round((state.runtimeMs || 0) / 60000),
    runtimeMinLimit: DAILY_RUNTIME_LIMIT_MIN,
    notifyEmail: state.notifyEmail || '',
    ccEmails: state.ccEmails || [],
    notify: state.notify || { pause: true, resume: true, complete: true },
    sdUrl: 'https://drive.google.com/drive/folders/' + state.sdRootId,
    sourceUrl: 'https://drive.google.com/drive/folders/' + state.sourceId,
    unmovableUrl: state.unmovableRemoved ? null : 'https://drive.google.com/drive/folders/' + state.unmovableId
  };
}

/** Lets the UI detect and resume an unfinished migration. */
function getMigrationStatus() {
  var raw = PropertiesService.getUserProperties().getProperty(STATE_KEY);
  if (!raw) return { none: true };
  return buildReport(JSON.parse(raw));
}

/** Clears saved migration state and any background triggers. */
function resetMigrationState() {
  var lock = LockService.getUserLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    removeTriggers();
    PropertiesService.getUserProperties().deleteProperty(STATE_KEY);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}
