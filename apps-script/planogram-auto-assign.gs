/**
 * Auto-assign PIC untuk PLANOGRAM_TASK berdasarkan manpower SHIFT=MASUK.
 * Pembagian memakai total move_qty (largest task first), bukan jumlah baris.
 */
const PLANOGRAM_ASSIGN_CONFIG = {
  SPREADSHEET_ID: '1sXemJ-p4DRXJ18BTtZo8pjvJeVJJhgJJMYnOlooOqps',
  TASK_SHEET: 'PLANOGRAM_TASK',
  MANPOWER_SHEET: 'raw mp',
};

function buildPlanogramQtyAssignment_(tasks, manpowerRows) {
  const active = [];
  const seenNames = {};

  (manpowerRows || []).forEach(function (row, sourceIndex) {
    const name = planogramAssignClean_(row && row.name);
    const shift = planogramAssignClean_(row && row.shift).toUpperCase();
    const key = name.toLowerCase();
    if (!name || shift !== 'MASUK' || seenNames[key]) return;
    seenNames[key] = true;
    active.push({
      name: name,
      name_key: key,
      source_index: sourceIndex,
      existing_task_count: 0,
      existing_qty: 0,
      assigned_task_count: 0,
      assigned_qty: 0,
      total_task_count: 0,
      total_qty: 0,
    });
  });

  const workloadByName = {};
  active.forEach(function (item) {
    workloadByName[item.name_key] = item;
  });

  const eligible = [];
  (tasks || []).forEach(function (task, sourceIndex) {
    const status = planogramAssignClean_(task && task.status).toUpperCase();
    const pic = planogramAssignClean_(task && task.pic);
    const qty = Math.max(0, planogramAssignNumber_(task && task.move_qty));
    if (status !== 'GENERATED') return;

    if (pic) {
      const existing = workloadByName[pic.toLowerCase()];
      if (!existing) return;
      existing.existing_task_count += 1;
      existing.existing_qty += qty;
      existing.total_task_count += 1;
      existing.total_qty += qty;
      return;
    }

    if (qty <= 0) return;
    eligible.push({
      task: task,
      task_key: planogramAssignClean_(task && task.task_key),
      qty: qty,
      source_index: sourceIndex,
    });
  });

  eligible.sort(function (left, right) {
    if (right.qty !== left.qty) return right.qty - left.qty;
    return left.source_index - right.source_index;
  });

  const assignments = [];
  eligible.forEach(function (item) {
    if (!active.length) return;
    let selected = active[0];
    for (let index = 1; index < active.length; index += 1) {
      const candidate = active[index];
      if (
        candidate.total_qty < selected.total_qty ||
        (candidate.total_qty === selected.total_qty &&
          candidate.total_task_count < selected.total_task_count) ||
        (candidate.total_qty === selected.total_qty &&
          candidate.total_task_count === selected.total_task_count &&
          candidate.source_index < selected.source_index)
      ) selected = candidate;
    }

    selected.assigned_task_count += 1;
    selected.assigned_qty += item.qty;
    selected.total_task_count += 1;
    selected.total_qty += item.qty;
    assignments.push({
      task_key: item.task_key,
      row_index: item.task && item.task.row_index,
      move_qty: item.qty,
      pic: selected.name,
    });
  });

  const eligibleQty = eligible.reduce(function (total, item) {
    return total + item.qty;
  }, 0);

  return {
    manpower_count: active.length,
    eligible_task_count: eligible.length,
    eligible_qty: eligibleQty,
    assigned_task_count: assignments.length,
    assigned_qty: assignments.reduce(function (total, item) {
      return total + item.move_qty;
    }, 0),
    can_assign: active.length > 0 && eligible.length > 0,
    assignments: assignments,
    workloads: active,
  };
}

function getPlanogramAssignmentPreview_() {
  const snapshot = loadPlanogramAssignmentSnapshot_();
  const result = buildPlanogramQtyAssignment_(snapshot.tasks, snapshot.manpower);
  return planogramAssignmentResponse_('PREVIEW', result);
}

function autoAssignPlanogramPics_() {
  const snapshot = loadPlanogramAssignmentSnapshot_();
  const result = buildPlanogramQtyAssignment_(snapshot.tasks, snapshot.manpower);

  if (result.assignments.length) {
    result.assignments.forEach(function (assignment) {
      snapshot.values[assignment.row_index][snapshot.pic_index] = assignment.pic;
    });
    snapshot.task_sheet
      .getRange(2, snapshot.pic_index + 1, snapshot.values.length, 1)
      .setValues(snapshot.values.map(function (row) { return [row[snapshot.pic_index]]; }));
  }

  return planogramAssignmentResponse_('SUCCESS', result);
}

function loadPlanogramAssignmentSnapshot_() {
  const spreadsheet = SpreadsheetApp.openById(PLANOGRAM_ASSIGN_CONFIG.SPREADSHEET_ID);
  const taskSheet = spreadsheet.getSheetByName(PLANOGRAM_ASSIGN_CONFIG.TASK_SHEET);
  const manpowerSheet = spreadsheet.getSheetByName(PLANOGRAM_ASSIGN_CONFIG.MANPOWER_SHEET);
  if (!taskSheet) throw new Error('Sheet PLANOGRAM_TASK tidak ditemukan.');
  if (!manpowerSheet) throw new Error('Sheet raw mp tidak ditemukan.');

  const taskLastColumn = taskSheet.getLastColumn();
  const taskLastRow = taskSheet.getLastRow();
  if (taskLastColumn < 1 || taskLastRow < 1) throw new Error('PLANOGRAM_TASK kosong.');
  const taskHeaders = taskSheet.getRange(1, 1, 1, taskLastColumn).getDisplayValues()[0];
  const taskKeyIndex = planogramAssignHeaderIndex_(taskHeaders, 'task_key');
  const qtyIndex = planogramAssignHeaderIndexAny_(taskHeaders, [
    'move_qty',
    'allocated_qty',
    'replenish_qty',
  ]);
  const statusIndex = planogramAssignHeaderIndex_(taskHeaders, 'status');
  const picIndex = planogramAssignHeaderIndex_(taskHeaders, 'pic');
  const taskValues = taskLastRow > 1
    ? taskSheet.getRange(2, 1, taskLastRow - 1, taskLastColumn).getValues()
    : [];
  const tasks = taskValues.map(function (row, rowIndex) {
    return {
      task_key: row[taskKeyIndex],
      move_qty: row[qtyIndex],
      status: row[statusIndex],
      pic: row[picIndex],
      row_index: rowIndex,
    };
  });

  const mpLastColumn = manpowerSheet.getLastColumn();
  const mpLastRow = manpowerSheet.getLastRow();
  const manpower = [];
  if (mpLastColumn > 0 && mpLastRow > 0) {
    const mpHeaders = manpowerSheet.getRange(1, 1, 1, mpLastColumn).getDisplayValues()[0];
    const nameIndex = planogramAssignHeaderIndex_(mpHeaders, 'manpower');
    const shiftIndex = planogramAssignHeaderIndex_(mpHeaders, 'shift');
    if (mpLastRow > 1) {
      manpowerSheet.getRange(2, 1, mpLastRow - 1, mpLastColumn).getDisplayValues()
        .forEach(function (row) {
          manpower.push({ name: row[nameIndex], shift: row[shiftIndex] });
        });
    }
  }

  return {
    task_sheet: taskSheet,
    pic_index: picIndex,
    values: taskValues,
    tasks: tasks,
    manpower: manpower,
  };
}

function planogramAssignmentResponse_(status, result) {
  return {
    status: status,
    balance_basis: 'move_qty',
    manpower_count: result.manpower_count,
    eligible_task_count: result.eligible_task_count,
    eligible_qty: result.eligible_qty,
    assigned_task_count: result.assigned_task_count,
    assigned_qty: result.assigned_qty,
    can_assign: result.can_assign,
    workloads: result.workloads.map(function (item) {
      return {
        name: item.name,
        existing_task_count: item.existing_task_count,
        existing_qty: item.existing_qty,
        assigned_task_count: item.assigned_task_count,
        assigned_qty: item.assigned_qty,
        total_task_count: item.total_task_count,
        total_qty: item.total_qty,
      };
    }),
  };
}

function planogramAssignHeaderIndex_(headers, expected) {
  const target = planogramAssignNormalizeHeader_(expected);
  for (let index = 0; index < headers.length; index += 1) {
    if (planogramAssignNormalizeHeader_(headers[index]) === target) return index;
  }
  throw new Error('Kolom ' + expected + ' tidak ditemukan.');
}

function planogramAssignHeaderIndexAny_(headers, expectedNames) {
  for (let index = 0; index < expectedNames.length; index += 1) {
    const expected = expectedNames[index];
    const target = planogramAssignNormalizeHeader_(expected);
    for (let column = 0; column < headers.length; column += 1) {
      if (planogramAssignNormalizeHeader_(headers[column]) === target) return column;
    }
  }
  throw new Error('Kolom ' + expectedNames.join(' / ') + ' tidak ditemukan.');
}

function planogramAssignNormalizeHeader_(value) {
  return planogramAssignClean_(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function planogramAssignClean_(value) {
  return value == null ? '' : String(value).trim();
}

function planogramAssignNumber_(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value == null ? '' : value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}
