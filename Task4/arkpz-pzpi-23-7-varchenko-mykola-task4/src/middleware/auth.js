import jwt from 'jsonwebtoken'
import { User } from '../models/index.js'

export async function auth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ message: 'Unauthorized' })

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)

    const user = await User.findByPk(payload.userId, {
      attributes: ['id', 'role', 'is_blocked']
    })

    if (!user) return res.status(401).json({ message: 'Unauthorized' })
    if (user.is_blocked) return res.status(403).json({ message: 'User is blocked' })

    req.user = {
      id: user.id,
      role: user.role
    }

    next()
  } catch {
    return res.status(401).json({ message: 'Invalid token' })
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ message: 'Unauthorized' })
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin only' })
  next()
}
