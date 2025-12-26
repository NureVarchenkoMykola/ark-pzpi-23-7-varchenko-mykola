import { Router } from 'express'
import { Op } from 'sequelize'
import { auth } from '../middleware/auth.js'
import { Appliance, Tariff, ConsumptionRecord } from '../models/index.js'

const router = Router()

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

function decimalString(value, digits) {
  const n = toNumber(value)
  if (!Number.isFinite(n)) return null
  return n.toFixed(digits)
}

async function getActiveTariffStrict(userId) {
  const rows = await Tariff.findAll({
    where: { user_id: userId, is_active: true },
    order: [['id', 'DESC']],
    limit: 2
  })

  if (rows.length === 0) {
    return { ok: false, code: 'NO_ACTIVE' }
  }
  if (rows.length > 1) {
    const ids = rows.map((t) => t.id)
    return { ok: false, code: 'MANY_ACTIVE', ids }
  }

  return { ok: true, tariff: rows[0] }
}

async function resolveApplianceForUser(userId, appliance_id) {
  if (appliance_id === undefined) return { keep: true }
  if (appliance_id === null) return { keep: false, appliance: null }

  const ap = await Appliance.findOne({
    where: { id: Number(appliance_id), user_id: userId }
  })
  if (!ap) return { error: 'appliance not found' }
  return { keep: false, appliance: ap }
}

function computeKwh({ consumption_kwh, usage_hours, appliance }) {
  if (consumption_kwh !== undefined && consumption_kwh !== null) {
    const kwh = toNumber(consumption_kwh)
    if (!Number.isFinite(kwh) || kwh <= 0) return { error: 'consumption_kwh must be a positive number' }
    return { kwh }
  }

  if (usage_hours !== undefined && usage_hours !== null) {
    const hours = toNumber(usage_hours)
    if (!Number.isFinite(hours) || hours <= 0) return { error: 'usage_hours must be a positive number' }
    if (!appliance) return { error: 'usage_hours requires appliance_id' }

    const power = toNumber(appliance.estimated_power)
    if (!Number.isFinite(power) || power <= 0) {
      return { error: 'appliance.estimated_power must be set (>0) to calculate kWh from usage_hours' }
    }

    return { kwh: power * hours }
  }

  return { error: 'Provide consumption_kwh OR usage_hours (with appliance_id)' }
}

/**
 * @openapi
 * /api/consumption:
 *   get:
 *     tags:
 *       - Consumption
 *     summary: List consumption records for current user (optional date filter)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date_from
 *         schema: { type: string, example: "2025-01-01" }
 *       - in: query
 *         name: date_to
 *         schema: { type: string, example: "2025-12-31" }
 *     responses:
 *       200:
 *         description: OK
 *       400:
 *         description: Validation error
 */
router.get('/', auth, async (req, res, next) => {
  try {
    const dateFrom = req.query.date_from ? String(req.query.date_from) : null
    const dateTo = req.query.date_to ? String(req.query.date_to) : null

    if (dateFrom && !isValidISODate(dateFrom)) {
      return res.status(400).json({ message: 'date_from must be YYYY-MM-DD' })
    }
    if (dateTo && !isValidISODate(dateTo)) {
      return res.status(400).json({ message: 'date_to must be YYYY-MM-DD' })
    }
    if (dateFrom && dateTo && isAfter(dateFrom, dateTo)) {
      return res.status(400).json({ message: 'date_from cannot be after date_to' })
    }

    const where = { user_id: req.user.id }
    if (dateFrom && dateTo) where.record_date = { [Op.between]: [dateFrom, dateTo] }
    else if (dateFrom) where.record_date = { [Op.gte]: dateFrom }
    else if (dateTo) where.record_date = { [Op.lte]: dateTo }

    const rows = await ConsumptionRecord.findAll({
      where,
      order: [['record_date', 'DESC'], ['id', 'DESC']]
    })

    res.json(rows)
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/consumption:
 *   post:
 *     tags:
 *       - Consumption
 *     summary: Add consumption record (cost is calculated using the active tariff)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [record_date]
 *             properties:
 *               appliance_id: { type: integer, example: 1 }
 *               consumption_kwh: { type: number, example: 3.5 }
 *               usage_hours: { type: number, example: 2.0 }
 *               record_date: { type: string, example: "2025-12-14" }
 *               notes: { type: string, example: "Evening usage" }
 *     responses:
 *       201:
 *         description: Created
 *       400:
 *         description: Validation error
 *       404:
 *         description: Appliance not found
 *       409:
 *         description: More than one active tariff
 */
router.post('/', auth, async (req, res, next) => {
  try {
    const { appliance_id, consumption_kwh, usage_hours, record_date, notes } = req.body || {}

    const hasKwh = consumption_kwh !== undefined && consumption_kwh !== null
    const hasHours = usage_hours !== undefined && usage_hours !== null

    if (hasKwh && hasHours) {
    return res.status(400).json({ message: 'Provide either consumption_kwh or usage_hours, not both' })
    }

    const date = String(record_date || '')
    if (!isValidISODate(date)) {
      return res.status(400).json({ message: 'record_date is required (YYYY-MM-DD)' })
    }

    const tCheck = await getActiveTariffStrict(req.user.id)
    if (!tCheck.ok) {
      if (tCheck.code === 'NO_ACTIVE') {
        return res.status(400).json({
          message: 'No active tariff. Please create a tariff and set it as active.'
        })
      }
      return res.status(409).json({
        message: 'More than one active tariff found. Please leave only one active tariff.',
        active_tariff_ids: tCheck.ids
      })
    }
    const activeTariff = tCheck.tariff

    let appliance = null
    if (appliance_id !== undefined && appliance_id !== null) {
      appliance = await Appliance.findOne({
        where: { id: Number(appliance_id), user_id: req.user.id }
      })
      if (!appliance) return res.status(404).json({ message: 'appliance not found' })
    }

    const kwhResult = computeKwh({ consumption_kwh, usage_hours, appliance })
    if (kwhResult.error) return res.status(400).json({ message: kwhResult.error })

    const price = toNumber(activeTariff.price_per_kwh)
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ message: 'Active tariff price_per_kwh is invalid' })
    }

    const kwhStr = decimalString(kwhResult.kwh, 3)
    const priceStr = decimalString(price, 4)
    const costStr = decimalString(toNumber(kwhStr) * toNumber(priceStr), 4)

    const created = await ConsumptionRecord.create({
      user_id: req.user.id,
      appliance_id: appliance ? appliance.id : null,
      consumption_kwh: kwhStr,
      applied_price_per_kwh: priceStr,
      cost: costStr,
      record_date: date,
      notes: notes || null
    })

    res.status(201).json(created)
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/consumption/{id}:
 *   patch:
 *     tags:
 *       - Consumption
 *     summary: Update consumption record (recalculates cost using the active tariff)
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
 *               appliance_id: { type: integer, example: 1, description: "set null to remove appliance" }
 *               consumption_kwh: { type: number, example: 4.2 }
 *               usage_hours: { type: number, example: 1.5 }
 *               record_date: { type: string, example: "2025-12-14" }
 *               notes: { type: string }
 *     responses:
 *       200:
 *         description: OK
 *       400:
 *         description: Validation error
 *       404:
 *         description: Not found
 *       409:
 *         description: More than one active tariff
 */
router.patch('/:id', auth, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    const row = await ConsumptionRecord.findOne({ where: { id, user_id: req.user.id } })
    if (!row) return res.status(404).json({ message: 'not found' })

    const { appliance_id, consumption_kwh, usage_hours, record_date, notes } = req.body || {}
	
    const hasKwh = consumption_kwh !== undefined && consumption_kwh !== null
    const hasHours = usage_hours !== undefined && usage_hours !== null

    if (hasKwh && hasHours) {
    return res.status(400).json({ message: 'Provide either consumption_kwh or usage_hours, not both' })
    }

    const nextDate = record_date == null ? String(row.record_date) : String(record_date)
    if (!isValidISODate(nextDate)) {
      return res.status(400).json({ message: 'record_date must be YYYY-MM-DD' })
    }

    const tCheck = await getActiveTariffStrict(req.user.id)
    if (!tCheck.ok) {
      if (tCheck.code === 'NO_ACTIVE') {
        return res.status(400).json({
          message: 'No active tariff. Please create a tariff and set it as active.'
        })
      }
      return res.status(409).json({
        message: 'More than one active tariff found. Please leave only one active tariff.',
        active_tariff_ids: tCheck.ids
      })
    }
    const activeTariff = tCheck.tariff

    const apRes = await resolveApplianceForUser(req.user.id, appliance_id)
    if (apRes.error) return res.status(404).json({ message: apRes.error })

    let nextApplianceId = row.appliance_id
    let appliance = null

    if (apRes.keep) {
      if (row.appliance_id != null) {
        appliance = await Appliance.findOne({ where: { id: Number(row.appliance_id), user_id: req.user.id } })
        if (!appliance) appliance = null
      }
    } else {
      appliance = apRes.appliance
      nextApplianceId = appliance ? appliance.id : null
    }

    let nextKwh = toNumber(row.consumption_kwh)

    const kwhProvided = consumption_kwh !== undefined && consumption_kwh !== null
    if (kwhProvided) {
      const k = toNumber(consumption_kwh)
      if (!Number.isFinite(k) || k <= 0) return res.status(400).json({ message: 'consumption_kwh must be a positive number' })
      nextKwh = k
    } else if (usage_hours !== undefined && usage_hours !== null) {
      const kwhResult = computeKwh({ consumption_kwh: undefined, usage_hours, appliance })
      if (kwhResult.error) return res.status(400).json({ message: kwhResult.error })
      nextKwh = kwhResult.kwh
    }

    if (!Number.isFinite(nextKwh) || nextKwh <= 0) {
      return res.status(400).json({ message: 'consumption_kwh must be a positive number' })
    }

    const price = toNumber(activeTariff.price_per_kwh)
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ message: 'Active tariff price_per_kwh is invalid' })
    }

    const kwhStr = decimalString(nextKwh, 3)
    const priceStr = decimalString(price, 4)
    const costStr = decimalString(toNumber(kwhStr) * toNumber(priceStr), 4)

    await row.update({
      appliance_id: nextApplianceId,
      consumption_kwh: kwhStr,
      applied_price_per_kwh: priceStr,
      cost: costStr,
      record_date: nextDate,
      notes: notes === undefined ? row.notes : (notes || null)
    })

    res.json(row)
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/consumption/{id}:
 *   delete:
 *     tags:
 *       - Consumption
 *     summary: Delete consumption record
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
    const row = await ConsumptionRecord.findOne({ where: { id, user_id: req.user.id } })
    if (!row) return res.status(404).json({ message: 'not found' })

    await row.destroy()
    res.status(204).send()
  } catch (e) {
    next(e)
  }
})

export default router
