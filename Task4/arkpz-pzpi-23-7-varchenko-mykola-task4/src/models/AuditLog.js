import { DataTypes } from 'sequelize'
import { sequelize } from '../config/db.js'

export const AuditLog = sequelize.define('AuditLog', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  admin_id: { type: DataTypes.INTEGER, allowNull: false },
  action: { type: DataTypes.STRING(64), allowNull: false },
	target_user_id: { type: DataTypes.INTEGER, allowNull: true },
	details: { type: DataTypes.TEXT('long'), allowNull: true, field: 'meta' },
  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
  tableName: 'audit_logs',
  timestamps: false
})
