import {z} from 'zod';
export const normalizedEmailSchema=z.string().trim().toLowerCase().pipe(z.email().max(254));
export const registrationSchema=z.object({
 name:z.string().trim().min(1,'Enter your name.').max(120),
 email:normalizedEmailSchema,
 password:z.string().min(8,'Use at least 8 characters.').max(128),
 confirmPassword:z.string().min(1),
}).strict().refine(value=>value.password===value.confirmPassword,{path:['confirmPassword'],message:'Passwords do not match.'});
export const memberByEmailSchema=z.object({email:normalizedEmailSchema,role:z.enum(['MANAGER','STAFF'])}).strict();
export type RegistrationInput=z.infer<typeof registrationSchema>;
