import { sequelize } from '../config/db.js'
import { User } from './User.js'
import { Appliance } from './Appliance.js'
import { Tariff } from './Tariff.js'
import { ConsumptionRecord } from './ConsumptionRecord.js'
import { Limit } from './Limit.js'
import { AuditLog } from './AuditLog.js'

AuditLog.belongsTo(User, { foreignKey: 'admin_id', as: 'admin' })
AuditLog.belongsTo(User, { foreignKey: 'target_user_id', as: 'target_user' })

export { sequelize, User, Appliance, Tariff, ConsumptionRecord, Limit, AuditLog }
