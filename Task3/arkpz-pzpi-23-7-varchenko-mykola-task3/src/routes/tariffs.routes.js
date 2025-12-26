import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { Tariff, sequelize } from '../models/index.js'
import { Op } from 'sequelize'

const router = Router()

function isAfter(dateA, dateB) {
  return String(dateA) > String(dateB)
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function isDateInRange(date, validFrom, validTo) {
  const d = String(date)
  const from = validFrom ? String(validFrom) : null
  const to = validTo ? String(validTo) : null

  if (from && d < from) return false
  if (to && d > to) return false
  return true
}

function assertCanBeActiveNow(validFrom, validTo) {
  const today = todayISO()
  if (!isDateInRange(today, validFrom, validTo)) {
    return {
      ok: false,
      message: `Tariff cannot be active now. Today (${today}) is outside the tariff validity range.`
    }
  }
  return { ok: true }
}


/**
 * @openapi
 * /api/tariffs:
 *   get:
 *     tags:
 *       - Tariffs
 *     summary: List tariffs for current user
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 */
router.get('/', auth, async (req, res, next) => {
  try {
    const rows = await Tariff.findAll({
      where: { user_id: req.user.id },
      order: [['id', 'DESC']]
    })
    res.json(rows)
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/tariffs:
 *   post:
 *     tags:
 *       - Tariffs
 *     summary: Create tariff (optionally make it active)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tariff_name, price_per_kwh, valid_from]
 *             properties:
 *               tariff_name: { type: string, example: "Day tariff" }
 *               price_per_kwh: { type: number, example: 4.32 }
 *               valid_from: { type: string, example: "2025-01-01" }
 *               valid_to: { type: string, example: "2025-12-31" }
 *               is_active: { type: boolean, example: true }
 *     responses:
 *       201:
 *         description: Created
 *       400:
 *         description: Validation error
 */
router.post('/', auth, async (req, res, next) => {
  try {
    const { tariff_name, price_per_kwh, valid_from, valid_to, is_active } = req.body || {}

    if (!tariff_name || price_per_kwh == null || !valid_from) {
      return res.status(400).json({ message: 'tariff_name, price_per_kwh, valid_from are required' })
    }

    if (valid_to && isAfter(valid_from, valid_to)) {
      return res.status(400).json({ message: 'valid_from cannot be after valid_to' })
    }

    const makeActive = is_active !== false

		if (makeActive) {
			const check = assertCanBeActiveNow(valid_from, valid_to || null)
			if (!check.ok) return res.status(400).json({ message: check.message })
		}

		const created = await sequelize.transaction(async (t) => {
			const newRow = await Tariff.create({
				user_id: req.user.id,
				tariff_name,
				price_per_kwh,
				valid_from,
				valid_to: valid_to || null,
				is_active: makeActive
			}, { transaction: t })

			if (makeActive) {
				await Tariff.update(
					{ is_active: false },
					{ where: { user_id: req.user.id, id: { [Op.ne]: newRow.id } }, transaction: t }
				)
			}

			return newRow
		})

    res.status(201).json(created)
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/tariffs/{id}:
 *   patch:
 *     tags:
 *       - Tariffs
 *     summary: Update tariff fields
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
 *               tariff_name: { type: string }
 *               price_per_kwh: { type: number }
 *               valid_from: { type: string }
 *               valid_to: { type: string }
 *               is_active: { type: boolean }
 *     responses:
 *       200:
 *         description: OK
 *       404:
 *         description: Not found
 */
router.patch('/:id', auth, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    const row = await Tariff.findOne({ where: { id, user_id: req.user.id } })
    if (!row) return res.status(404).json({ message: 'not found' })

    const { tariff_name, price_per_kwh, valid_from, valid_to, is_active } = req.body || {}

    const nextValidFrom = valid_from ?? row.valid_from
    const nextValidTo = valid_to === undefined ? row.valid_to : (valid_to || null)

    if (nextValidTo && isAfter(nextValidFrom, nextValidTo)) {
      return res.status(400).json({ message: 'valid_from cannot be after valid_to' })
    }

		const nextIsActive = is_active === undefined ? row.is_active : Boolean(is_active)

		if (nextIsActive) {
			const check = assertCanBeActiveNow(nextValidFrom, nextValidTo)
			if (!check.ok) return res.status(400).json({ message: check.message })
		}

    const updated = await sequelize.transaction(async (t) => {
			if (is_active === true) {
				await Tariff.update(
					{ is_active: false },
					{ where: { user_id: req.user.id, id: { [Op.ne]: row.id } }, transaction: t }
				)
			}

      await row.update({
        tariff_name: tariff_name ?? row.tariff_name,
        price_per_kwh: price_per_kwh ?? row.price_per_kwh,
        valid_from: nextValidFrom,
        valid_to: nextValidTo,
        is_active: nextIsActive
      }, { transaction: t })

      return row
    })

    res.json(updated)
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/tariffs/{id}/activate:
 *   post:
 *     tags:
 *       - Tariffs
 *     summary: Set a tariff as active (and deactivate others)
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
router.post('/:id/activate', auth, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    const row = await Tariff.findOne({ where: { id, user_id: req.user.id } })
    if (!row) return res.status(404).json({ message: 'not found' })

    if (row.is_active) {
      return res.json(row)
    }

		const check = assertCanBeActiveNow(row.valid_from, row.valid_to)
    if (!check.ok) return res.status(400).json({ message: check.message })

    const updated = await sequelize.transaction(async (t) => {
			await Tariff.update(
				{ is_active: false },
				{ where: { user_id: req.user.id, id: { [Op.ne]: row.id } }, transaction: t }
			)

      await row.update({ is_active: true }, { transaction: t })
      return row
    })

    res.json(updated)
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/tariffs/{id}:
 *   delete:
 *     tags:
 *       - Tariffs
 *     summary: Delete tariff
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
    const row = await Tariff.findOne({ where: { id, user_id: req.user.id } })
    if (!row) return res.status(404).json({ message: 'not found' })

    await row.destroy()
    res.status(204).send()
  } catch (e) {
    next(e)
  }
})

export default router
