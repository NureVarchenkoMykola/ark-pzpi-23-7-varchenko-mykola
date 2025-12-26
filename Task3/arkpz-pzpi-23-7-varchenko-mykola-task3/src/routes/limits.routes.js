import { Router } from 'express'
import { Op } from 'sequelize'
import { auth } from '../middleware/auth.js'
import { Limit, ConsumptionRecord } from '../models/index.js'

const router = Router()

const PERIOD_TYPES = new Set(['week', 'month', 'year', 'custom'])

function toNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : NaN
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

function pad2(n) {
  return String(n).padStart(2, '0')
}

function parseDateUTC(s) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

function formatDateUTC(dt) {
  const y = dt.getUTCFullYear()
  const m = pad2(dt.getUTCMonth() + 1)
  const d = pad2(dt.getUTCDate())
  return `${y}-${m}-${d}`
}

function addDaysUTC(dt, days) {
  return new Date(dt.getTime() + days * 24 * 60 * 60 * 1000)
}

function addMonthsUTC(dt, months) {
  const y = dt.getUTCFullYear()
  const m = dt.getUTCMonth()
  const d = dt.getUTCDate()

  const targetMonthIndex = m + months
  const ty = y + Math.floor(targetMonthIndex / 12)
  const tm = ((targetMonthIndex % 12) + 12) % 12

  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate()
  const day = Math.min(d, lastDay)

  return new Date(Date.UTC(ty, tm, day))
}

function addYearsUTC(dt, years) {
  return addMonthsUTC(dt, years * 12)
}

function calcAutoPeriodEnd(periodType, startStr) {
  const startDt = parseDateUTC(startStr)

  if (periodType === 'week') {
    return formatDateUTC(addDaysUTC(startDt, 6))
  }

  if (periodType === 'month') {
    const next = addMonthsUTC(startDt, 1)
    return formatDateUTC(addDaysUTC(next, -1))
  }

  if (periodType === 'year') {
    const next = addYearsUTC(startDt, 1)
    return formatDateUTC(addDaysUTC(next, -1))
  }

  return null
}

function resolvePeriodEndOrFail({ res, type, start, endFromBody, endFromDb }) {
  if (type === 'custom') {
    const end = endFromBody !== undefined ? String(endFromBody || '') : String(endFromDb || '')
    if (!isValidISODate(end)) {
      res.status(400).json({ message: 'period_end is required for custom and must be YYYY-MM-DD' })
      return null
    }
    if (isAfter(start, end)) {
      res.status(400).json({ message: 'period_start cannot be after period_end' })
      return null
    }
    return end
  }

  const autoEnd = calcAutoPeriodEnd(type, start)
  if (!autoEnd) {
    res.status(400).json({ message: 'period_type must be one of: week, month, year, custom' })
    return null
  }

  if (endFromBody !== undefined) {
    const provided = String(endFromBody || '')
    if (!isValidISODate(provided)) {
      res.status(400).json({ message: 'period_end must be YYYY-MM-DD' })
      return null
    }
    if (provided !== autoEnd) {
      res.status(400).json({
        message: `period_end is auto-calculated for period_type=${type}. Expected ${autoEnd}`,
        expected_period_end: autoEnd
      })
      return null
    }
  }

  return autoEnd
}

function decimalString(value, digits) {
  const n = toNumber(value)
  if (!Number.isFinite(n)) return null
  return n.toFixed(digits)
}

function parseBool(v) {
  if (v === true || v === false) return v
  if (v === 1 || v === 0) return Boolean(v)
  if (typeof v === 'string') {
    if (v === 'true') return true
    if (v === 'false') return false
    if (v === '1') return true
    if (v === '0') return false
  }
  return null
}

async function findOverlappingLimit({ userId, periodType, start, end, excludeId }) {
  const where = {
    user_id: userId,
    period_type: periodType,
    period_start: { [Op.lte]: end },
    period_end: { [Op.gte]: start }
  }
  if (excludeId != null) where.id = { [Op.ne]: excludeId }

  return Limit.findOne({ where })
}

/**
 * @openapi
 * /api/limits:
 *   get:
 *     tags:
 *       - Limits
 *     summary: List limits for current user (optional filters)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: period_type
 *         schema: { type: string, example: "month" }
 *       - in: query
 *         name: date
 *         schema: { type: string, example: "2025-12-14" }
 *         description: "If provided, returns limits that cover this date"
 *     responses:
 *       200:
 *         description: OK
 *       400:
 *         description: Validation error
 */
router.get('/', auth, async (req, res, next) => {
  try {
    const periodType = req.query.period_type ? String(req.query.period_type) : null
    const date = req.query.date ? String(req.query.date) : null

    if (periodType && !PERIOD_TYPES.has(periodType)) {
      return res.status(400).json({ message: 'period_type must be one of: week, month, year, custom' })
    }
    if (date && !isValidISODate(date)) {
      return res.status(400).json({ message: 'date must be YYYY-MM-DD' })
    }

    const where = { user_id: req.user.id }
    if (periodType) where.period_type = periodType
    if (date) {
      where.period_start = { [Op.lte]: date }
      where.period_end = { [Op.gte]: date }
    }

    const rows = await Limit.findAll({
      where,
      order: [['period_start', 'DESC'], ['id', 'DESC']]
    })

    res.json(rows)
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/limits:
 *   post:
 *     tags:
 *       - Limits
 *     summary: Create limit
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [limit_kwh, period_type, period_start]
 *             properties:
 *               limit_kwh: { type: number, example: 150.0 }
 *               period_type: { type: string, example: "month" }
 *               period_start: { type: string, example: "2025-12-01" }
 *               period_end: { type: string, example: "2025-12-31", description: "Required only for custom."}
 *               alert_enabled: { type: boolean, example: true }
 *               alert_threshold_percent: { type: integer, example: 80 }
 *     responses:
 *       201:
 *         description: Created
 *       400:
 *         description: Validation error
 *       409:
 *         description: Overlapping limit for same period_type
 */
router.post('/', auth, async (req, res, next) => {
  try {
    const {
      limit_kwh,
      period_type,
      period_start,
      period_end,
      alert_enabled,
      alert_threshold_percent
    } = req.body || {}

    const type = String(period_type || '')
    if (!PERIOD_TYPES.has(type)) {
      return res.status(400).json({ message: 'period_type must be one of: week, month, year, custom' })
    }

    const start = String(period_start || '')
    if (!isValidISODate(start)) {
    return res.status(400).json({ message: 'period_start must be YYYY-MM-DD' })
    }

    const end = resolvePeriodEndOrFail({
    res,
    type,
    start,
    endFromBody: period_end
    })
    if (!end) return

    const limitStr = decimalString(limit_kwh, 3)
    if (limitStr == null || toNumber(limitStr) <= 0) {
      return res.status(400).json({ message: 'limit_kwh must be a positive number' })
    }

    const alertEnabledParsed = alert_enabled === undefined ? true : parseBool(alert_enabled)
    if (alertEnabledParsed == null) {
      return res.status(400).json({ message: 'alert_enabled must be boolean' })
    }

    const thresholdRaw = alert_threshold_percent === undefined ? 80 : Number(alert_threshold_percent)
    if (!Number.isInteger(thresholdRaw) || thresholdRaw < 1 || thresholdRaw > 100) {
      return res.status(400).json({ message: 'alert_threshold_percent must be integer 1..100' })
    }

    const overlap = await findOverlappingLimit({
      userId: req.user.id,
      periodType: type,
      start,
      end
    })
    if (overlap) {
      return res.status(409).json({
        message: 'Overlapping limit exists for this period_type',
        existing_limit_id: overlap.id
      })
    }

    const created = await Limit.create({
      user_id: req.user.id,
      limit_kwh: limitStr,
      period_type: type,
      period_start: start,
      period_end: end,
      alert_enabled: alertEnabledParsed,
      alert_threshold_percent: thresholdRaw
    })

    res.status(201).json(created)
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/limits/{id}:
 *   patch:
 *     tags:
 *       - Limits
 *     summary: Update limit
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               limit_kwh: { type: number, example: 200.0 }
 *               period_type: { type: string, example: "month" }
 *               period_start: { type: string, example: "2025-12-01" }
 *               period_end: { type: string, example: "2025-12-31" }
 *               alert_enabled: { type: boolean, example: true }
 *               alert_threshold_percent: { type: integer, example: 85 }
 *     responses:
 *       200:
 *         description: OK
 *       400:
 *         description: Validation error
 *       404:
 *         description: Not found
 *       409:
 *         description: Overlapping limit for same period_type
 */
router.patch('/:id', auth, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    const row = await Limit.findOne({ where: { id, user_id: req.user.id } })
    if (!row) return res.status(404).json({ message: 'not found' })

    const body = req.body || {}

    const nextType = body.period_type === undefined ? String(row.period_type) : String(body.period_type || '')
    if (!PERIOD_TYPES.has(nextType)) {
      return res.status(400).json({ message: 'period_type must be one of: week, month, year, custom' })
    }

		const nextStart = body.period_start === undefined ? String(row.period_start) : String(body.period_start || '')
		if (!isValidISODate(nextStart)) {
			return res.status(400).json({ message: 'period_start must be YYYY-MM-DD' })
		}

		const nextEnd = resolvePeriodEndOrFail({
			res,
			type: nextType,
			start: nextStart,
			endFromBody: body.period_end,
			endFromDb: row.period_end
		})
		if (!nextEnd) return

    const nextLimitStr = body.limit_kwh === undefined
      ? String(row.limit_kwh)
      : decimalString(body.limit_kwh, 3)

    if (nextLimitStr == null || toNumber(nextLimitStr) <= 0) {
      return res.status(400).json({ message: 'limit_kwh must be a positive number' })
    }

    const nextAlertEnabled = body.alert_enabled === undefined ? parseBool(row.alert_enabled) : parseBool(body.alert_enabled)
    if (nextAlertEnabled == null) {
      return res.status(400).json({ message: 'alert_enabled must be boolean' })
    }

    const nextThreshold = body.alert_threshold_percent === undefined
      ? Number(row.alert_threshold_percent)
      : Number(body.alert_threshold_percent)

    if (!Number.isInteger(nextThreshold) || nextThreshold < 1 || nextThreshold > 100) {
      return res.status(400).json({ message: 'alert_threshold_percent must be integer 1..100' })
    }

    const overlap = await findOverlappingLimit({
      userId: req.user.id,
      periodType: nextType,
      start: nextStart,
      end: nextEnd,
      excludeId: id
    })
    if (overlap) {
      return res.status(409).json({
        message: 'Overlapping limit exists for this period_type',
        existing_limit_id: overlap.id
      })
    }

    await row.update({
      limit_kwh: nextLimitStr,
      period_type: nextType,
      period_start: nextStart,
      period_end: nextEnd,
      alert_enabled: nextAlertEnabled,
      alert_threshold_percent: nextThreshold
    })

    res.json(row)
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/limits/{id}:
 *   delete:
 *     tags:
 *       - Limits
 *     summary: Delete limit
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204:
 *         description: Deleted
 *       404:
 *         description: Not found
 */
router.delete('/:id', auth, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    const row = await Limit.findOne({ where: { id, user_id: req.user.id } })
    if (!row) return res.status(404).json({ message: 'not found' })

    await row.destroy()
    res.status(204).send()
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/limits/{id}/progress:
 *   get:
 *     tags:
 *       - Limits
 *     summary: Get progress for limit (used kWh, percent, alerts)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: OK
 *       404:
 *         description: Not found
 */
router.get('/:id/progress', auth, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    const limit = await Limit.findOne({ where: { id, user_id: req.user.id } })
    if (!limit) return res.status(404).json({ message: 'not found' })

    const start = String(limit.period_start)
    const end = String(limit.period_end)

    const sum = await ConsumptionRecord.sum('consumption_kwh', {
      where: {
        user_id: req.user.id,
        record_date: { [Op.between]: [start, end] }
      }
    })

    const used = Number(sum || 0)
    const limitKwh = toNumber(limit.limit_kwh)
    const percent = Number.isFinite(limitKwh) && limitKwh > 0 ? (used / limitKwh) * 100 : null

    const threshold = Number(limit.alert_threshold_percent || 80)
    const alertEnabled = Boolean(limit.alert_enabled)

    const thresholdReached = alertEnabled && percent != null && percent >= threshold
    const exceeded = percent != null && percent >= 100

    res.json({
      limit_id: limit.id,
      period_type: limit.period_type,
      period_start: start,
      period_end: end,
      limit_kwh: String(limit.limit_kwh),
      used_kwh: used.toFixed(3),
      percent_used: percent == null ? null : Number(percent.toFixed(2)),
      alert_enabled: alertEnabled,
      alert_threshold_percent: threshold,
      threshold_reached: thresholdReached,
      limit_exceeded: exceeded
    })
  } catch (e) {
    next(e)
  }
})

export default router
