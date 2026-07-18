import { Gender, ID, ISODateString, UserRole } from './common';

export interface User {
  id: ID;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  avatarUrl?: string;
  createdAt: ISODateString;
}

export interface Doctor extends User {
  role: UserRole.Doctor;
  specialty: string;
  licenseNumber?: string;
  bio?: string;
}

export interface Patient extends User {
  role: UserRole.Patient;
  dateOfBirth?: ISODateString;
  gender?: Gender;
  phone?: string;
}
