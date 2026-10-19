import {useState,type FormEvent} from 'react';
import {Link,Navigate,useNavigate} from 'react-router-dom';
import {registrationSchema} from '@qevra/contracts';
import {useAuth} from '../../app/auth-context';
import {getSupabase} from '../../lib/supabase';
import {Panel,Field,Button,ErrorNotice,Loading} from '../../components/ui';
export function RegisterPage(){
 const auth=useAuth(),navigate=useNavigate();
 const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[submitted,setSubmitted]=useState(false);
 if(auth.loading)return <Loading/>;
 if(auth.session&&!auth.session.user.is_anonymous)return <Navigate to="/app" replace/>;
 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();const form=new FormData(event.currentTarget);
  const parsed=registrationSchema.safeParse({name:form.get('name'),email:form.get('email'),password:form.get('password'),confirmPassword:form.get('confirmPassword')});
  if(!parsed.success){setError(parsed.error.issues.map(issue=>issue.message).join(' '));return;}
  setBusy(true);setError(null);
  try{
   const {data,error}=await getSupabase().auth.signUp({email:parsed.data.email,password:parsed.data.password,
    options:{data:{full_name:parsed.data.name},emailRedirectTo:window.location.origin+'/login'}});
   if(error){
    if(error.code==='user_already_exists'||error.code==='email_exists')setError('An account may already exist for this email. Try signing in.');
    else if(error.code==='weak_password')setError('Choose a stronger password with a mix of letters, numbers and symbols.');
    else if(error.status===429)setError('Too many registration attempts. Please wait before trying again.');
    else setError('Registration could not be completed. Please try again later.');
   }else if(data.session)navigate('/app',{replace:true});
   else setSubmitted(true);
  }catch{setError('Unable to reach authentication. Please try again.');}finally{setBusy(false);}
 }
 return <div className="mx-auto max-w-md"><Panel title={submitted?'Check your email':'Create your Qevra account'}>
 {submitted?<><p role="status" className="text-sm text-slate-600">If registration is available for this email, a confirmation link has been sent. Confirm your email, then sign in. If you already have an account, sign in instead.</p><Link className="button mt-5" to="/login">Go to login</Link></>:
 <><p className="mb-6 text-sm text-slate-500">For business owners and team members. Customers can join queues without registering.</p>
 <form onSubmit={event=>{void submit(event);}} className="space-y-4">
 <Field label="Name"><input className="input" name="name" autoComplete="name" required maxLength={120}/></Field>
 <Field label="Email"><input className="input" name="email" type="email" autoComplete="email" required maxLength={254}/></Field>
 <Field label="Password" hint="At least 8 characters."><input aria-label="Password" className="input" name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={128}/></Field>
 <Field label="Confirm password"><input className="input" name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} maxLength={128}/></Field>
 <ErrorNotice message={error}/><Button disabled={busy} type="submit">{busy?'Creating account…':'Create account'}</Button>
 </form><p className="mt-5 text-sm">Already registered? <Link className="text-teal-800 underline" to="/login">Sign in</Link></p></>}
 </Panel></div>;
}
