import { AppointmentStatus, ID, ISODateString } from './common';

export interface Appointment {
  id: ID;
  doctorId: ID;
  patientId: ID;
  status: AppointmentStatus;
  startsAt: ISODateString;
  endsAt: ISODateString;
  reason?: string;
  notes?: string;
  createdAt: ISODateString;
}
