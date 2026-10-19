BEGIN;
ALTER TABLE public.profiles ADD COLUMN normalized_email text;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_normalized_email_check
 CHECK(normalized_email IS NULL OR (normalized_email=lower(btrim(normalized_email)) AND length(normalized_email) BETWEEN 3 AND 254));
CREATE UNIQUE INDEX profiles_normalized_email_unique ON public.profiles(normalized_email) WHERE normalized_email IS NOT NULL;
CREATE FUNCTION public.sync_business_auth_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE profile_name text;
BEGIN
 IF coalesce(NEW.is_anonymous,false) OR nullif(btrim(NEW.email),'') IS NULL OR NEW.deleted_at IS NOT NULL THEN
  UPDATE public.profiles SET normalized_email=NULL WHERE user_id=NEW.id;
  RETURN NEW;
 END IF;
 profile_name:=left(nullif(btrim(NEW.raw_user_meta_data->>'full_name'),''),120);
 INSERT INTO public.profiles(user_id,display_name,normalized_email,created_at)
 VALUES(NEW.id,coalesce(profile_name,'Qevra user'),lower(btrim(NEW.email)),coalesce(NEW.created_at,now()))
 ON CONFLICT(user_id) DO UPDATE SET normalized_email=EXCLUDED.normalized_email,
 display_name=coalesce(profile_name,profiles.display_name),updated_at=now();
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_business_auth_profile() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER qevra_business_auth_profile
 AFTER INSERT OR UPDATE OF email,raw_user_meta_data,is_anonymous,deleted_at ON auth.users
 FOR EACH ROW EXECUTE FUNCTION public.sync_business_auth_profile();
-- Existing accounts retain their names unless Auth contains an explicit full name.
INSERT INTO public.profiles(user_id,display_name,normalized_email,created_at)
 SELECT id,coalesce(left(nullif(btrim(raw_user_meta_data->>'full_name'),''),120),'Qevra user'),
 lower(btrim(email)),coalesce(created_at,now())
 FROM auth.users WHERE NOT coalesce(is_anonymous,false) AND nullif(btrim(email),'') IS NOT NULL AND deleted_at IS NULL
 ON CONFLICT(user_id) DO UPDATE SET normalized_email=EXCLUDED.normalized_email;
COMMIT;
