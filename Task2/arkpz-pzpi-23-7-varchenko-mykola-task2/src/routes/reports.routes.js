import { Router } from 'express'
import { Op } from 'sequelize'
import { auth } from '../middleware/auth.js'
import { Appliance, ConsumptionRecord, Limit, sequelize } from '../models/index.js'

const router = Router()

function toNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function isValidISODate(s) {
  if (typeof s !== 'string') return false
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false

  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))

  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  )
}

function isAfter(dateA, dateB) {
  return String(dateA) > String(dateB)
}

function parseDateUTC(s) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

function daysInclusive(dateFrom, dateTo) {
  const a = parseDateUTC(dateFrom)
  const b = parseDateUTC(dateTo)
  const diff = b.getTime() - a.getTime()
  if (!Number.isFinite(diff) || diff < 0) return 0
  return Math.floor(diff / (24 * 60 * 60 * 1000)) + 1
}

function requirePeriod(req, res) {
  const dateFrom = req.query.date_from ? String(req.query.date_from) : null
  const dateTo = req.query.date_to ? String(req.query.date_to) : null

  if (!dateFrom || !dateTo) {
    res.status(400).json({ message: 'date_from and date_to are required (YYYY-MM-DD)' })
    return null
  }
  if (!isValidISODate(dateFrom)) {
    res.status(400).json({ message: 'date_from must be YYYY-MM-DD' })
    return null
  }
  if (!isValidISODate(dateTo)) {
    res.status(400).json({ message: 'date_to must be YYYY-MM-DD' })
    return null
  }
  if (isAfter(dateFrom, dateTo)) {
    res.status(400).json({ message: 'date_from cannot be after date_to' })
    return null
  }

  return { dateFrom, dateTo }
}

function buildWhere(userId, dateFrom, dateTo) {
  return {
    user_id: userId,
    record_date: { [Op.between]: [dateFrom, dateTo] }
  }
}

/**
 * @openapi
 * /api/reports/summary:
 *   get:
 *     tags:
 *       - Reports
 *     summary: Summary report for a period (totals, averages, max-day)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date_from
 *         required: true
 *         schema: { type: string, example: "2025-12-01" }
 *       - in: query
 *         name: date_to
 *         required: true
 *         schema: { type: string, example: "2025-12-31" }
 *     responses:
 *       200:
 *         description: OK
 *       400:
 *         description: Validation error
 */
router.get('/summary', auth, async (req, res, next) => {
  try {
    const period = requirePeriod(req, res)
    if (!period) return

    const { dateFrom, dateTo } = period
    const where = buildWhere(req.user.id, dateFrom, dateTo)
    const days = daysInclusive(dateFrom, dateTo)

    const totalsRow = await ConsumptionRecord.findOne({
      where,
      attributes: [
        [sequelize.fn('SUM', sequelize.col('consumption_kwh')), 'total_kwh'],
        [sequelize.fn('SUM', sequelize.col('cost')), 'total_cost'],
        [sequelize.fn('COUNT', sequelize.col('id')), 'records_count']
      ],
      raw: true
    })

    const totalKwh = toNumber(totalsRow?.total_kwh, 0)
    const totalCost = toNumber(totalsRow?.total_cost, 0)
    const recordsCount = toNumber(totalsRow?.records_count, 0)

    const maxDayRow = await ConsumptionRecord.findOne({
      where,
      attributes: [
        'record_date',
        [sequelize.fn('SUM', sequelize.col('consumption_kwh')), 'day_kwh'],
        [sequelize.fn('SUM', sequelize.col('cost')), 'day_cost']
      ],
      group: ['record_date'],
      order: [[sequelize.literal('day_kwh'), 'DESC']],
      raw: true
    })

    const maxDay = maxDayRow
      ? {
          date: String(maxDayRow.record_date),
          kwh: toNumber(maxDayRow.day_kwh, 0),
          cost: toNumber(maxDayRow.day_cost, 0)
        }
      : null

    const averages = {
      kwh_per_day: days > 0 ? Number((totalKwh / days).toFixed(4)) : 0,
      cost_per_day: days > 0 ? Number((totalCost / days).toFixed(4)) : 0,
      kwh_per_record: recordsCount > 0 ? Number((totalKwh / recordsCount).toFixed(4)) : 0,
      cost_per_record: recordsCount > 0 ? Number((totalCost / recordsCount).toFixed(4)) : 0
    }

    res.json({
      period: { date_from: dateFrom, date_to: dateTo, days },
      totals: { total_kwh: totalKwh, total_cost: totalCost, records_count: recordsCount },
      averages,
      max_day: maxDay
    })
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/reports/daily:
 *   get:
 *     tags:
 *       - Reports
 *     summary: Daily report (kWh and cost grouped by day)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date_from
 *         required: true
 *         schema: { type: string, example: "2025-12-01" }
 *       - in: query
 *         name: date_to
 *         required: true
 *         schema: { type: string, example: "2025-12-31" }
 *     responses:
 *       200:
 *         description: OK
 *       400:
 *         description: Validation error
 */
router.get('/daily', auth, async (req, res, next) => {
  try {
    const period = requirePeriod(req, res)
    if (!period) return

    const { dateFrom, dateTo } = period
    const where = buildWhere(req.user.id, dateFrom, dateTo)

    const rows = await ConsumptionRecord.findAll({
      where,
      attributes: [
        'record_date',
        [sequelize.fn('SUM', sequelize.col('consumption_kwh')), 'total_kwh'],
        [sequelize.fn('SUM', sequelize.col('cost')), 'total_cost'],
        [sequelize.fn('COUNT', sequelize.col('id')), 'records_count']
      ],
      group: ['record_date'],
      order: [['record_date', 'ASC']],
      raw: true
    })

    res.json(
      rows.map((r) => ({
        record_date: String(r.record_date),
        total_kwh: toNumber(r.total_kwh, 0),
        total_cost: toNumber(r.total_cost, 0),
        records_count: toNumber(r.records_count, 0)
      }))
    )
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/reports/by-appliance:
 *   get:
 *     tags:
 *       - Reports
 *     summary: Distribution by appliances (kWh and cost grouped by appliance_id)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date_from
 *         required: true
 *         schema: { type: string, example: "2025-12-01" }
 *       - in: query
 *         name: date_to
 *         required: true
 *         schema: { type: string, example: "2025-12-31" }
 *     responses:
 *       200:
 *         description: OK
 *       400:
 *         description: Validation error
 */
router.get('/by-appliance', auth, async (req, res, next) => {
  try {
    const period = requirePeriod(req, res)
    if (!period) return

    const { dateFrom, dateTo } = period
    const where = buildWhere(req.user.id, dateFrom, dateTo)

    const grouped = await ConsumptionRecord.findAll({
      where,
      attributes: [
        'appliance_id',
        [sequelize.fn('SUM', sequelize.col('consumption_kwh')), 'total_kwh'],
        [sequelize.fn('SUM', sequelize.col('cost')), 'total_cost'],
        [sequelize.fn('COUNT', sequelize.col('id')), 'records_count']
      ],
      group: ['appliance_id'],
      order: [[sequelize.literal('total_cost'), 'DESC']],
      raw: true
    })

    const ids = grouped
      .map((g) => g.appliance_id)
      .filter((id) => id !== null && id !== undefined)
      .map((id) => Number(id))

    const appliances = ids.length
      ? await Appliance.findAll({
          where: { user_id: req.user.id, id: { [Op.in]: ids } },
          attributes: ['id', 'name'],
          raw: true
        })
      : []

    const nameById = new Map(appliances.map((a) => [Number(a.id), a.name]))

    res.json(
      grouped.map((g) => {
        const apId = g.appliance_id == null ? null : Number(g.appliance_id)
        return {
          appliance_id: apId,
          appliance_name: apId == null ? null : (nameById.get(apId) || null),
          total_kwh: toNumber(g.total_kwh, 0),
          total_cost: toNumber(g.total_cost, 0),
          records_count: toNumber(g.records_count, 0)
        }
      })
    )
  } catch (e) {
    next(e)
  }
})

const PERIOD_TYPES = new Set(['week', 'month', 'year', 'custom'])
const LIMIT_STATUSES = new Set(['ok', 'threshold_reached', 'limit_exceeded'])

function parseCsvList(value) {
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseIdsList(value) {
  const items = parseCsvList(value)
  const ids = items.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0)
  return ids.length ? ids : []
}

function optionalPeriod(req, res) {
  const hasFrom = req.query.date_from != null && String(req.query.date_from).trim() !== ''
  const hasTo = req.query.date_to != null && String(req.query.date_to).trim() !== ''

  if (!hasFrom && !hasTo) return null
  if (!hasFrom || !hasTo) {
    res.status(400).json({ message: 'date_from and date_to must be provided together (YYYY-MM-DD)' })
    return null
  }

  const dateFrom = String(req.query.date_from)
  const dateTo = String(req.query.date_to)

  if (!isValidISODate(dateFrom)) {
    res.status(400).json({ message: 'date_from must be YYYY-MM-DD' })
    return null
  }
  if (!isValidISODate(dateTo)) {
    res.status(400).json({ message: 'date_to must be YYYY-MM-DD' })
    return null
  }
  if (isAfter(dateFrom, dateTo)) {
    res.status(400).json({ message: 'date_from cannot be after date_to' })
    return null
  }

  return { dateFrom, dateTo }
}

function normalizeLimitRow(r) {
  const limitKwh = toNumber(r.limit_kwh, 0)
  const usedKwh = toNumber(r.used_kwh, 0)

  const alertEnabled = Boolean(r.alert_enabled)
  const threshold = Number(r.alert_threshold_percent || 80)

  const percent = limitKwh > 0 ? (usedKwh / limitKwh) * 100 : 0

  const limitExceeded = percent >= 100
  const thresholdReached = !limitExceeded && alertEnabled && percent >= threshold

  let status = 'ok'
  if (limitExceeded) status = 'limit_exceeded'
  else if (thresholdReached) status = 'threshold_reached'

  return {
    id: Number(r.id),
    period_type: String(r.period_type),
    period_start: String(r.period_start),
    period_end: String(r.period_end),
    limit_kwh: Number(limitKwh.toFixed(3)),
    used_kwh: Number(usedKwh.toFixed(3)),
    remaining_kwh: Number(Math.max(0, limitKwh - usedKwh).toFixed(3)),
    percent_used: Number(percent.toFixed(2)),
    alert_enabled: alertEnabled,
    alert_threshold_percent: Number.isFinite(threshold) ? threshold : 80,
    threshold_reached: thresholdReached,
    limit_exceeded: limitExceeded,
    status
  }
}

async function fetchLimitsReportData({ userId, types, statuses, ids, period }) {
  const whereParts = ['l.user_id = :userId']
  const repl = { userId }

  if (types && types.length) {
    const ph = types.map((_, i) => `:t${i}`)
    for (let i = 0; i < types.length; i++) repl[`t${i}`] = types[i]
    whereParts.push(`l.period_type IN (${ph.join(', ')})`)
  }

  if (ids && ids.length) {
    const ph = ids.map((_, i) => `:id${i}`)
    for (let i = 0; i < ids.length; i++) repl[`id${i}`] = ids[i]
    whereParts.push(`l.id IN (${ph.join(', ')})`)
  }

  if (period) {
    whereParts.push('l.period_start <= :dateTo AND l.period_end >= :dateFrom')
    repl.dateFrom = period.dateFrom
    repl.dateTo = period.dateTo
  }

  const sql = `
    SELECT
      l.id,
      l.period_type,
      l.period_start,
      l.period_end,
      l.limit_kwh,
      l.alert_enabled,
      l.alert_threshold_percent,
      COALESCE(SUM(c.consumption_kwh), 0) AS used_kwh
    FROM limits l
    LEFT JOIN consumption_records c
      ON c.user_id = l.user_id
     AND c.record_date BETWEEN l.period_start AND l.period_end
    WHERE ${whereParts.join(' AND ')}
    GROUP BY l.id
    ORDER BY l.period_start DESC, l.id DESC
  `

  const [rows] = await sequelize.query(sql, { replacements: repl })
  let items = rows.map(normalizeLimitRow)

  if (statuses && statuses.length) {
    const want = new Set(statuses)
    items = items.filter((it) => want.has(it.status))
  }

  const totals = {
    limits_count: items.length,
    ok_count: items.filter((i) => i.status === 'ok').length,
    threshold_reached_count: items.filter((i) => i.status === 'threshold_reached').length,
    limit_exceeded_count: items.filter((i) => i.status === 'limit_exceeded').length,
    total_limit_kwh: Number(items.reduce((a, i) => a + toNumber(i.limit_kwh, 0), 0).toFixed(3)),
    total_used_kwh: Number(items.reduce((a, i) => a + toNumber(i.used_kwh, 0), 0).toFixed(3))
  }

  return { totals, items }
}

/**
 * @openapi
 * /api/reports/limits:
 *   get:
 *     tags:
 *       - Reports
 *     summary: "Limits report (filters: period_type, ids, status; optional overlap by date_from/date_to)"
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: period_type
 *         schema: { type: string, example: "month,year" }
 *         description: "Comma-separated: week,month,year,custom"
 *       - in: query
 *         name: ids
 *         schema: { type: string, example: "1,2,3" }
 *         description: "Comma-separated limit ids"
 *       - in: query
 *         name: status
 *         schema: { type: string, example: "ok,threshold_reached" }
 *         description: "Comma-separated: ok,threshold_reached,limit_exceeded"
 *       - in: query
 *         name: date_from
 *         schema: { type: string, example: "2025-01-01" }
 *         description: "Optional (must be with date_to): select limits whose periods overlap [date_from..date_to]"
 *       - in: query
 *         name: date_to
 *         schema: { type: string, example: "2025-12-31" }
 *     responses:
 *       200:
 *         description: OK
 *       400:
 *         description: Validation error
 */
router.get('/limits', auth, async (req, res, next) => {
  try {
    const types = req.query.period_type ? parseCsvList(req.query.period_type) : null
    if (types) {
      for (const t of types) {
        if (!PERIOD_TYPES.has(t)) {
          return res.status(400).json({ message: 'period_type must be week, month, year, custom (comma-separated allowed)' })
        }
      }
    }

    const ids = req.query.ids ? parseIdsList(req.query.ids) : null
    if (req.query.ids && (!ids || ids.length === 0)) {
      return res.status(400).json({ message: 'ids must be comma-separated positive integers' })
    }

    const statuses = req.query.status ? parseCsvList(req.query.status) : null
    if (statuses) {
      for (const s of statuses) {
        if (!LIMIT_STATUSES.has(s)) {
          return res.status(400).json({ message: 'status must be ok, threshold_reached, limit_exceeded (comma-separated allowed)' })
        }
      }
    }

    const period = optionalPeriod(req, res)
    if (period === null && (req.query.date_from || req.query.date_to)) return

    const data = await fetchLimitsReportData({
      userId: req.user.id,
      types,
      statuses,
      ids,
      period
    })

    res.json({
      filters: {
        period_type: types || null,
        ids: ids || null,
        status: statuses || null,
        period: period ? { date_from: period.dateFrom, date_to: period.dateTo } : null
      },
      totals: data.totals,
      items: data.items
    })
  } catch (e) {
    next(e)
  }
})

// export
function excelNormalize(value) {
  if (value === null || value === undefined) return ''

  let s = String(value)

  if (/^-?\d+(\.\d+)?$/.test(s)) {
    s = s.replace('.', ',')
  }

  return s
}

function csvEscape(value) {
  const s = excelNormalize(value)
  if (/[;"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function toCsv(headers, rows, delimiter = ';') {
  const sepLine = `sep=${delimiter}\n`
  const head = headers.map(csvEscape).join(delimiter)
  const body = rows
    .map((r) => headers.map((h) => csvEscape(r[h])).join(delimiter))
    .join('\n')

  return `\uFEFF${sepLine}${head}\n${body}\n`
}

function sendCsv(res, filename, csvText) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(csvText)
}

/**
 * @openapi
 * /api/reports/export/summary.csv:
 *   get:
 *     tags:
 *       - Reports Export
 *     summary: Export summary report as CSV
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date_from
 *         required: true
 *         schema: { type: string, example: "2025-12-01" }
 *       - in: query
 *         name: date_to
 *         required: true
 *         schema: { type: string, example: "2025-12-31" }
 *     responses:
 *       200:
 *         description: CSV file
 *         content:
 *           text/csv: {}
 *       400:
 *         description: Validation error
 */
router.get('/export/summary.csv', auth, async (req, res, next) => {
  try {
    const period = requirePeriod(req, res)
    if (!period) return
    const { dateFrom, dateTo } = period

    const where = buildWhere(req.user.id, dateFrom, dateTo)
    const days = daysInclusive(dateFrom, dateTo)

    const totalsRow = await ConsumptionRecord.findOne({
      where,
      attributes: [
        [sequelize.fn('SUM', sequelize.col('consumption_kwh')), 'total_kwh'],
        [sequelize.fn('SUM', sequelize.col('cost')), 'total_cost'],
        [sequelize.fn('COUNT', sequelize.col('id')), 'records_count']
      ],
      raw: true
    })

    const totalKwh = toNumber(totalsRow?.total_kwh, 0)
    const totalCost = toNumber(totalsRow?.total_cost, 0)
    const recordsCount = toNumber(totalsRow?.records_count, 0)

    const maxDayRow = await ConsumptionRecord.findOne({
      where,
      attributes: [
        'record_date',
        [sequelize.fn('SUM', sequelize.col('consumption_kwh')), 'day_kwh'],
        [sequelize.fn('SUM', sequelize.col('cost')), 'day_cost']
      ],
      group: ['record_date'],
      order: [[sequelize.literal('day_kwh'), 'DESC']],
      raw: true
    })

    const maxDayDate = maxDayRow ? String(maxDayRow.record_date) : ''
    const maxDayKwh = maxDayRow ? toNumber(maxDayRow.day_kwh, 0) : 0
    const maxDayCost = maxDayRow ? toNumber(maxDayRow.day_cost, 0) : 0

    const kwhPerDay = days > 0 ? Number((totalKwh / days).toFixed(4)) : 0
    const costPerDay = days > 0 ? Number((totalCost / days).toFixed(4)) : 0
    const kwhPerRecord = recordsCount > 0 ? Number((totalKwh / recordsCount).toFixed(4)) : 0
    const costPerRecord = recordsCount > 0 ? Number((totalCost / recordsCount).toFixed(4)) : 0

    const headers = [
      'date_from',
      'date_to',
      'days',
      'total_kwh',
      'total_cost',
      'records_count',
      'kwh_per_day',
      'cost_per_day',
      'kwh_per_record',
      'cost_per_record',
      'max_day_date',
      'max_day_kwh',
      'max_day_cost'
    ]

    const rows = [{
      date_from: dateFrom,
      date_to: dateTo,
      days,
      total_kwh: totalKwh,
      total_cost: totalCost,
      records_count: recordsCount,
      kwh_per_day: kwhPerDay,
      cost_per_day: costPerDay,
      kwh_per_record: kwhPerRecord,
      cost_per_record: costPerRecord,
      max_day_date: maxDayDate,
      max_day_kwh: maxDayKwh,
      max_day_cost: maxDayCost
    }]

    const csv = toCsv(headers, rows, ';')
    sendCsv(res, `report_summary_${dateFrom}_to_${dateTo}.csv`, csv)
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/reports/export/daily.csv:
 *   get:
 *     tags:
 *       - Reports Export
 *     summary: Export daily report as CSV
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date_from
 *         required: true
 *         schema: { type: string, example: "2025-12-01" }
 *       - in: query
 *         name: date_to
 *         required: true
 *         schema: { type: string, example: "2025-12-31" }
 *     responses:
 *       200:
 *         description: CSV file
 *         content:
 *           text/csv: {}
 */
router.get('/export/daily.csv', auth, async (req, res, next) => {
  try {
    const period = requirePeriod(req, res)
    if (!period) return
    const { dateFrom, dateTo } = period

    const where = buildWhere(req.user.id, dateFrom, dateTo)

    const rows = await ConsumptionRecord.findAll({
      where,
      attributes: [
        'record_date',
        [sequelize.fn('SUM', sequelize.col('consumption_kwh')), 'total_kwh'],
        [sequelize.fn('SUM', sequelize.col('cost')), 'total_cost'],
        [sequelize.fn('COUNT', sequelize.col('id')), 'records_count']
      ],
      group: ['record_date'],
      order: [['record_date', 'ASC']],
      raw: true
    })

    const normalized = rows.map((r) => ({
      record_date: String(r.record_date),
      total_kwh: toNumber(r.total_kwh, 0),
      total_cost: toNumber(r.total_cost, 0),
      records_count: toNumber(r.records_count, 0)
    }))

    const headers = ['record_date', 'total_kwh', 'total_cost', 'records_count']
    const csv = toCsv(headers, normalized, ';')
    sendCsv(res, `report_daily_${dateFrom}_to_${dateTo}.csv`, csv)
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/reports/export/by-appliance.csv:
 *   get:
 *     tags:
 *       - Reports Export
 *     summary: Export by-appliance report as CSV
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date_from
 *         required: true
 *         schema: { type: string, example: "2025-12-01" }
 *       - in: query
 *         name: date_to
 *         required: true
 *         schema: { type: string, example: "2025-12-31" }
 *     responses:
 *       200:
 *         description: CSV file
 *         content:
 *           text/csv: {}
 */
router.get('/export/by-appliance.csv', auth, async (req, res, next) => {
  try {
    const period = requirePeriod(req, res)
    if (!period) return
    const { dateFrom, dateTo } = period

    const where = buildWhere(req.user.id, dateFrom, dateTo)

    const grouped = await ConsumptionRecord.findAll({
      where,
      attributes: [
        'appliance_id',
        [sequelize.fn('SUM', sequelize.col('consumption_kwh')), 'total_kwh'],
        [sequelize.fn('SUM', sequelize.col('cost')), 'total_cost'],
        [sequelize.fn('COUNT', sequelize.col('id')), 'records_count']
      ],
      group: ['appliance_id'],
      order: [[sequelize.literal('total_cost'), 'DESC']],
      raw: true
    })

    const ids = grouped
      .map((g) => g.appliance_id)
      .filter((id) => id !== null && id !== undefined)
      .map((id) => Number(id))

    const appliances = ids.length
      ? await Appliance.findAll({
          where: { user_id: req.user.id, id: { [Op.in]: ids } },
          attributes: ['id', 'name'],
          raw: true
        })
      : []

    const nameById = new Map(appliances.map((a) => [Number(a.id), a.name]))

    const normalized = grouped.map((g) => {
      const apId = g.appliance_id == null ? null : Number(g.appliance_id)
      return {
        appliance_id: apId,
        appliance_name: apId == null ? '' : (nameById.get(apId) || ''),
        total_kwh: toNumber(g.total_kwh, 0),
        total_cost: toNumber(g.total_cost, 0),
        records_count: toNumber(g.records_count, 0)
      }
    })

    const headers = ['appliance_id', 'appliance_name', 'total_kwh', 'total_cost', 'records_count']
    const csv = toCsv(headers, normalized, ';')
    sendCsv(res, `report_by_appliance_${dateFrom}_to_${dateTo}.csv`, csv)
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/reports/export/limits.csv:
 *   get:
 *     tags:
 *       - Reports Export
 *     summary: Export limits report as CSV
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: period_type
 *         schema: { type: string, example: "month,year" }
 *       - in: query
 *         name: ids
 *         schema: { type: string, example: "1,2,3" }
 *       - in: query
 *         name: status
 *         schema: { type: string, example: "limit_exceeded" }
 *       - in: query
 *         name: date_from
 *         schema: { type: string, example: "2025-01-01" }
 *       - in: query
 *         name: date_to
 *         schema: { type: string, example: "2025-12-31" }
 *     responses:
 *       200:
 *         description: CSV file
 *         content:
 *           text/csv: {}
 *       400:
 *         description: Validation error
 */
router.get('/export/limits.csv', auth, async (req, res, next) => {
  try {
    const types = req.query.period_type ? parseCsvList(req.query.period_type) : null
    if (types) {
      for (const t of types) {
        if (!PERIOD_TYPES.has(t)) {
          return res.status(400).json({ message: 'period_type must be week, month, year, custom (comma-separated allowed)' })
        }
      }
    }

    const ids = req.query.ids ? parseIdsList(req.query.ids) : null
    if (req.query.ids && (!ids || ids.length === 0)) {
      return res.status(400).json({ message: 'ids must be comma-separated positive integers' })
    }

    const statuses = req.query.status ? parseCsvList(req.query.status) : null
    if (statuses) {
      for (const s of statuses) {
        if (!LIMIT_STATUSES.has(s)) {
          return res.status(400).json({ message: 'status must be ok, threshold_reached, limit_exceeded (comma-separated allowed)' })
        }
      }
    }

    const period = optionalPeriod(req, res)
    if (period === null && (req.query.date_from || req.query.date_to)) return

    const data = await fetchLimitsReportData({
      userId: req.user.id,
      types,
      statuses,
      ids,
      period
    })

    const headers = [
      'id',
      'period_type',
      'period_start',
      'period_end',
      'limit_kwh',
      'used_kwh',
      'remaining_kwh',
      'percent_used',
      'alert_enabled',
      'alert_threshold_percent',
      'status'
    ]

    const rows = data.items.map((i) => ({
      id: i.id,
      period_type: i.period_type,
      period_start: i.period_start,
      period_end: i.period_end,
      limit_kwh: i.limit_kwh,
      used_kwh: i.used_kwh,
      remaining_kwh: i.remaining_kwh,
      percent_used: i.percent_used,
      alert_enabled: i.alert_enabled ? 1 : 0,
      alert_threshold_percent: i.alert_threshold_percent,
      status: i.status
    }))

    rows.push({
      id: 'TOTAL',
      period_type: '',
      period_start: '',
      period_end: '',
      limit_kwh: data.totals.total_limit_kwh,
      used_kwh: data.totals.total_used_kwh,
      remaining_kwh: '',
      percent_used: '',
      alert_enabled: '',
      alert_threshold_percent: '',
      status: `count=${data.totals.limits_count}; ok=${data.totals.ok_count}; thr=${data.totals.threshold_reached_count}; exc=${data.totals.limit_exceeded_count}`
    })

    const csv = toCsv(headers, rows, ';')
    const namePart = period ? `${period.dateFrom}_to_${period.dateTo}` : 'all'
    sendCsv(res, `report_limits_${namePart}.csv`, csv)
  } catch (e) {
    next(e)
  }
})

export default router
